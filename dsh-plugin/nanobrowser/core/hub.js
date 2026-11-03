// The browser hub: the only process/instance that talks to the Nanobrowser extension.
//
// Extension side (v1): GET /poll, POST /result, GET /health. v2 adds POST /event.
// Client side: POST /client/register, POST /client/call, POST /client/cancel, POST /client/lease,
//              DELETE /client/lease, GET /client/events.
//
// The hub owns the command queue, call lifecycle, client registry and tab leases. The DSH plugin embeds one; the MCP
// adapter connects to it, or starts its own when no hub is running. Only the hub listens on 127.0.0.1.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { TOOL_NAMES } from './tools.js';
import { LeaseManager } from './leases.js';
import { WsConnection } from './ws.js';

const DEFAULT_PORT = 8790;
const DEFAULT_TOKEN = 'dev-token';
const DEFAULT_CALL_TIMEOUT_MS = 360_000;
const POLL_TIMEOUT_MS = 20_000;
const STALE_CONNECTION_MS = 60_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_HISTORY = 200;

/** The call arguments as short values, so the audit trail and the prompt stay bounded. */
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return undefined;
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') out[key] = value.length > 120 ? `${value.slice(0, 119)}…` : value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = `[${value.length}]`;
    else out[key] = '{…}';
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function summarizeResult(value) {
  const text = typeof value?.text === 'string' ? value.text : '';
  if (!text) return undefined;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class Hub {
  constructor(options = {}) {
    this.port = Number(options.port ?? DEFAULT_PORT);
    this.token = String(options.token ?? DEFAULT_TOKEN);
    this.callTimeoutMs = Number(options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
    this.pollTimeoutMs = Number(options.pollTimeoutMs ?? POLL_TIMEOUT_MS);
    this.staleConnectionMs = Number(options.staleConnectionMs ?? STALE_CONNECTION_MS);
    this.logger = options.logger ?? console;
    this.queue = [];
    this.calls = new Map();
    this.clients = new Map();
    this.leases = new LeaseManager();
    this.poll = null;
    this.lastPollAt = 0;
    this.server = null;
    this.started = false;
    this.starting = false;
    this.stopped = false;
    this.connectionState = false;
    this.eventClients = new Set();
    this.history = [];
    this.chatService = null;
    this.approvalService = null;
    this.userStepService = null;
    this.wsClients = new Set();
    this.heartbeat = null;
    this.watchdog = null;
  }

  get connected() {
    return this.lastPollAt > 0 && Date.now() - this.lastPollAt <= this.staleConnectionMs;
  }

  async start({ retryMs = 2000, signal } = {}) {
    if (this.started) return this;
    if (this.starting) return this;
    this.starting = true;
    this.stopped = false;
    let loggedBusy = false;
    try {
      for (;;) {
        if (signal?.aborted || this.stopped) throw new Error('the hub start was cancelled');
        const server = http.createServer((req, res) => {
          void this.#handle(req, res).catch(error => {
            this.#log('request failed:', error?.message ?? String(error));
            this.#sendJson(res, 500, { ok: false, error: 'internal error' });
          });
        });
        // Long /client/call requests may wait for a confirmation card; do not let Node time them out.
        server.requestTimeout = 0;
        server.headersTimeout = 0;
        try {
          await this.#listen(server, this.port);
        } catch (error) {
          try {
            server.close();
          } catch {
            /* already closed */
          }
          if (error?.code !== 'EADDRINUSE') throw error;
          if (!loggedBusy) {
            this.#log(`port ${this.port} is in use; retrying until it is free`);
            loggedBusy = true;
          }
          await delay(retryMs, signal);
          continue;
        }
        if (signal?.aborted || this.stopped) {
          server.close();
          throw new Error('the hub start was cancelled');
        }
        this.server = server;
        server.on('upgrade', (req, socket, head) => {
          void this.#handleUpgrade(req, socket, head).catch(error => {
            this.#log('websocket upgrade failed:', error?.message ?? String(error));
            try {
              socket.destroy();
            } catch {
              /* already gone */
            }
          });
        });
        this.port = server.address().port;
        this.started = true;
        this.heartbeat = setInterval(() => this.#heartbeat(), 15_000);
        this.heartbeat.unref?.();
        this.watchdog = setInterval(() => this.#watchConnection(), 5_000);
        this.watchdog.unref?.();
        this.#log(`listening on http://127.0.0.1:${this.port}`);
        return this;
      }
    } finally {
      this.starting = false;
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearInterval(this.watchdog);
    this.heartbeat = null;
    this.watchdog = null;
    for (const call of [...this.calls.values()]) this.#settle(call.id, { ok: false, text: 'The browser hub stopped.' });
    this.calls.clear();
    this.queue.length = 0;
    if (this.poll) {
      const pending = this.poll;
      this.poll = null;
      this.#endPoll(pending, []);
    }
    for (const client of [...this.eventClients]) {
      try {
        client.res.end();
      } catch {
        /* already closed */
      }
    }
    this.eventClients.clear();
    for (const client of [...this.wsClients]) {
      try {
        client.connection?.close(1001);
      } catch {
        /* already gone */
      }
    }
    this.wsClients.clear();
    this.leases.clear();
    const server = this.server;
    this.server = null;
    this.started = false;
    this.connectionState = false;
    if (!server) return;
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  registerClient({ clientId, kind = 'unknown', sessionId = null, tabId = null } = {}) {
    const id = String(clientId || randomUUID());
    const previous = this.clients.get(id);
    const client = {
      clientId: id,
      kind: String(kind),
      sessionId: sessionId ?? null,
      tabId: tabId ?? null,
      registeredAt: previous?.registeredAt ?? Date.now(),
      lastSeen: Date.now(),
    };
    this.clients.set(id, client);
    return { ...client };
  }

  unregisterClient(clientId) {
    this.clients.delete(String(clientId));
    const released = this.leases.release(String(clientId));
    if (released) this.#emit({ type: 'lease', clientId: String(clientId), lease: null, released: true });
    return released;
  }

  /**
   * Queues one tool call and resolves with the layer's Result. `callId` lets an MCP adapter correlate a JSON-RPC
   * request with its cancellation; without it the hub mints one.
   */
  call(clientId, tool, args = {}, options = {}) {
    const disconnected = this.#ensureConnected();
    if (disconnected) return Promise.resolve(disconnected);
    const signal = options.signal;
    if (signal?.aborted) return Promise.resolve({ ok: false, text: 'The call was cancelled.' });
    const id = options.callId ? String(options.callId) : randomUUID();
    if (this.calls.has(id)) return Promise.resolve({ ok: false, text: `A call with id "${id}" is already running.` });
    const timeoutMs = Number(options.timeoutMs ?? this.callTimeoutMs);
    const client = String(clientId ?? 'anonymous');
    return new Promise(resolve => {
      const call = {
        id,
        clientId: client,
        tool,
        args,
        startedAt: Date.now(),
        resolve,
        timer: null,
        signal,
        onAbort: null,
        settled: false,
      };
      this.calls.set(id, call);
      const cancel = text => {
        if (call.settled) return;
        this.#enqueue({ id: randomUUID(), clientId: call.clientId, tool: 'cancel', args: { id } });
        this.#settle(id, { ok: false, text });
      };
      if (signal) {
        call.onAbort = () => cancel('The call was cancelled.');
        signal.addEventListener('abort', call.onAbort, { once: true });
      }
      call.timer = setTimeout(() => {
        cancel(
          `The extension did not answer within ${timeoutMs} ms. The call was cancelled; nothing else was dispatched.`,
        );
      }, timeoutMs);
      this.#enqueue({ id, clientId: call.clientId, tool, args });
      this.#emit({ type: 'call-start', callId: id, clientId: call.clientId, tool, args: summarizeArgs(args) });
    });
  }

  cancel(clientId, callId) {
    const call = this.calls.get(String(callId));
    if (!call) return false;
    if (clientId && call.clientId !== String(clientId)) return false;
    this.#enqueue({ id: randomUUID(), clientId: call.clientId, tool: 'cancel', args: { id: call.id } });
    this.#settle(call.id, { ok: false, text: 'The call was cancelled.' });
    return true;
  }

  acquireLease(clientId, options = {}) {
    const result = this.leases.acquire(String(clientId), options);
    if (result.ok) this.#emit({ type: 'lease', clientId: String(clientId), lease: result.lease });
    return result;
  }

  bindLease(clientId, tabId) {
    const result = this.leases.bind(String(clientId), tabId);
    if (result.ok) this.#emit({ type: 'lease', clientId: String(clientId), lease: result.lease });
    return result;
  }

  releaseLease(clientId) {
    const released = this.leases.release(String(clientId));
    if (released) this.#emit({ type: 'lease', clientId: String(clientId), lease: null, released: true });
    return released;
  }

  leaseOf(clientId) {
    return this.leases.leaseOf(String(clientId));
  }

  ownerOf(tabId) {
    return this.leases.ownerOf(Number(tabId));
  }

  status() {
    return {
      ok: true,
      connected: this.connected,
      port: this.port,
      lastPollAt: this.lastPollAt,
      clients: [...this.clients.values()],
      leases: this.leases.list(),
      pendingCalls: this.calls.size,
      queued: this.queue.length,
    };
  }

  /** Recent calls, paired with their outcome. `clientId` omitted means every client. */
  audit(clientId, limit = 20) {
    const calls = new Map();
    for (const event of this.history) {
      if (event.type !== 'call-start' && event.type !== 'call-end') continue;
      if (clientId !== undefined && event.clientId !== clientId) continue;
      if (event.type === 'call-start') {
        calls.set(event.callId, {
          callId: event.callId,
          tool: event.tool,
          clientId: event.clientId,
          at: event.at,
          ok: undefined,
          ...(event.args ? { args: event.args } : {}),
        });
      } else if (calls.has(event.callId)) {
        const call = calls.get(event.callId);
        call.ok = event.ok;
        if (typeof event.ms === 'number') call.ms = event.ms;
        if (event.text) call.text = event.text;
      }
    }
    const size = Math.max(1, Math.min(100, Number(limit) || 20));
    return [...calls.values()].sort((a, b) => a.at - b.at).slice(-size);
  }

  onEvent(listener) {
    this.eventListeners ??= new Set();
    this.eventListeners.add(listener);
    return () => this.eventListeners?.delete(listener);
  }

  setChatService(service) {
    this.chatService = service;
  }

  setApprovalService(service) {
    this.approvalService = service;
  }

  setUserStepService(service) {
    this.userStepService = service;
  }

  hasWsClients() {
    return this.wsClients.size > 0;
  }

  publish(event) {
    this.#emit(event);
  }

  // ---- HTTP -----------------------------------------------------------------------------------------------------

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    this.#cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!this.#authorized(url, req)) {
      this.#sendText(res, 401, 'unauthorized');
      return;
    }
    const path = url.pathname;
    if (req.method === 'GET' && path === '/health') {
      this.#sendJson(res, 200, this.status());
      return;
    }
    if (req.method === 'GET' && path === '/poll') {
      this.#handlePoll(res);
      return;
    }
    if (req.method === 'POST' && path === '/result') {
      const body = await this.#readBody(req);
      const id = String(body.id ?? '');
      const result = body.result ?? { ok: false, text: 'The extension returned no result.' };
      const settled = this.#settle(id, result);
      this.#sendJson(res, 200, { ok: true, settled });
      return;
    }
    if (req.method === 'POST' && path === '/event') {
      const body = await this.#readBody(req);
      this.#handleExtensionEvent(body);
      this.#sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && path === '/client/register') {
      const body = await this.#readBody(req);
      const client = this.registerClient(body);
      this.#sendJson(res, 200, { ok: true, client, hub: this.status() });
      return;
    }
    if (req.method === 'POST' && path === '/client/call') {
      const body = await this.#readBody(req);
      const tool = String(body.tool ?? '');
      if (!TOOL_NAMES.has(tool)) {
        this.#sendJson(res, 400, { ok: false, error: `Unknown tool: ${tool}` });
        return;
      }
      const result = await this.call(String(body.clientId ?? 'anonymous'), tool, body.args ?? {}, {
        callId: body.callId === undefined ? undefined : String(body.callId),
        timeoutMs: body.timeoutMs,
      });
      this.#sendJson(res, 200, { ok: true, result });
      return;
    }
    if (req.method === 'POST' && path === '/client/cancel') {
      const body = await this.#readBody(req);
      const cancelled = this.cancel(String(body.clientId ?? ''), String(body.callId ?? ''));
      this.#sendJson(res, 200, { ok: true, cancelled });
      return;
    }
    if (req.method === 'POST' && path === '/client/lease') {
      const body = await this.#readBody(req);
      const clientId = String(body.clientId ?? '');
      if (!clientId) {
        this.#sendJson(res, 400, { ok: false, error: 'clientId is required' });
        return;
      }
      const result =
        body.release === true
          ? { ok: true, released: this.releaseLease(clientId) }
          : this.acquireLease(clientId, {
              tabId: body.tabId === undefined || body.tabId === null ? null : Number(body.tabId),
              sessionId: body.sessionId ?? null,
              kind: body.kind ?? 'unknown',
            });
      this.#sendJson(res, 200, result);
      return;
    }
    if (req.method === 'DELETE' && path === '/client/lease') {
      const clientId = String(url.searchParams.get('clientId') ?? '');
      this.#sendJson(res, 200, { ok: true, released: this.releaseLease(clientId) });
      return;
    }
    if (req.method === 'GET' && path === '/client/events') {
      this.#handleSse(req, res, url.searchParams.get('clientId'));
      return;
    }
    if (req.method === 'GET' && path === '/client/chat/sessions') {
      if (!this.chatService) {
        this.#sendJson(res, 503, { ok: false, error: 'chat is not available' });
        return;
      }
      try {
        this.#sendJson(res, 200, { ok: true, sessions: await this.chatService.sessions() });
      } catch (error) {
        this.#sendJson(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
      return;
    }
    if (req.method === 'GET' && path === '/client/chat/history') {
      if (!this.chatService) {
        this.#sendJson(res, 503, { ok: false, error: 'chat is not available' });
        return;
      }
      try {
        const sessionId = String(url.searchParams.get('sessionId') ?? '');
        this.#sendJson(res, 200, { ok: true, ...(await this.chatService.history(sessionId)) });
      } catch (error) {
        this.#sendJson(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
      return;
    }
    if (req.method === 'POST' && path === '/client/chat/send') {
      if (!this.chatService) {
        this.#sendJson(res, 503, { ok: false, error: 'chat is not available' });
        return;
      }
      const body = await this.#readBody(req);
      try {
        this.#sendJson(res, 200, { ok: true, ...(await this.chatService.send(body)) });
      } catch (error) {
        this.#sendJson(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
      return;
    }
    if (req.method === 'POST' && path === '/client/chat/stop') {
      if (!this.chatService) {
        this.#sendJson(res, 503, { ok: false, error: 'chat is not available' });
        return;
      }
      const body = await this.#readBody(req);
      try {
        this.#sendJson(res, 200, { ok: true, ...(await this.chatService.stop({ sessionId: body.sessionId })) });
      } catch (error) {
        this.#sendJson(res, 400, { ok: false, error: error?.message ?? String(error) });
      }
      return;
    }
    if (req.method === 'POST' && path === '/client/approval') {
      if (!this.approvalService) {
        this.#sendJson(res, 503, { ok: false, error: 'approvals are not available' });
        return;
      }
      const body = await this.#readBody(req);
      const answered = this.approvalService.answer(String(body.id ?? ''), String(body.decision ?? ''));
      this.#sendJson(res, 200, { ok: true, answered });
      return;
    }
    if (req.method === 'POST' && path === '/client/user-step') {
      if (!this.userStepService) {
        this.#sendJson(res, 503, { ok: false, error: 'user steps are not available' });
        return;
      }
      const body = await this.#readBody(req);
      const answered = this.userStepService.answer(String(body.id ?? ''));
      this.#sendJson(res, 200, { ok: true, answered });
      return;
    }
    this.#sendJson(res, 404, { ok: false, error: 'not found' });
  }

  async #handleUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!this.#authorized(url, req)) {
      this.#rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    if (url.pathname !== '/client/chat/ws') {
      this.#rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!this.chatService) {
      this.#rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    const client = { connection: null, sessionId: url.searchParams.get('sessionId') };
    const connection = new WsConnection(
      socket,
      req,
      {
        onMessage: text => {
          void this.#handleChatMessage(client, text);
        },
        onClose: () => this.wsClients.delete(client),
      },
      head,
    );
    client.connection = connection;
    this.wsClients.add(client);
    try {
      const hello = await this.chatService.hello(client.sessionId);
      client.sessionId = hello.sessionId ?? client.sessionId;
      connection.sendJson({ type: 'hello', ...hello });
    } catch (error) {
      connection.sendJson({ type: 'error', error: error?.message ?? String(error) });
    }
  }

  #rejectUpgrade(socket, status, text) {
    try {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    } catch {
      /* already gone */
    }
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }

  async #handleChatMessage(client, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      client.connection?.sendJson({ type: 'error', error: 'invalid JSON' });
      return;
    }
    if (!this.chatService || !client.connection) {
      client.connection?.sendJson({ type: 'error', error: 'chat is not available' });
      return;
    }
    try {
      if (message.type === 'sessions') {
        client.connection.sendJson({ type: 'sessions', sessions: await this.chatService.sessions() });
        return;
      }
      if (message.type === 'select') {
        const sessionId = String(message.sessionId ?? '');
        client.sessionId = sessionId;
        client.connection.sendJson({ type: 'history', ...(await this.chatService.history(sessionId)) });
        return;
      }
      if (message.type === 'send') {
        const sessionId = String(message.sessionId ?? client.sessionId ?? '');
        if (!sessionId) throw new Error('Select a session first.');
        const result = await this.chatService.send({
          sessionId,
          text: message.text,
          mode: message.mode,
          includePage: message.includePage,
        });
        client.sessionId = sessionId;
        client.connection.sendJson({ type: 'sent', ...result });
        return;
      }
      if (message.type === 'stop') {
        const sessionId = String(message.sessionId ?? client.sessionId ?? '');
        if (!sessionId) throw new Error('Select a session first.');
        client.connection.sendJson({ type: 'stopped', ...(await this.chatService.stop({ sessionId })) });
        return;
      }
      if (message.type === 'approval') {
        const answered =
          this.approvalService?.answer(String(message.id ?? ''), String(message.decision ?? '')) ?? false;
        client.connection.sendJson({ type: 'approval-answer', id: message.id, answered });
        return;
      }
      if (message.type === 'user-step') {
        const answered = this.userStepService?.answer(String(message.id ?? '')) ?? false;
        client.connection.sendJson({ type: 'user-step-answer', id: message.id, answered });
        return;
      }
      client.connection.sendJson({ type: 'error', error: `unknown message type: ${message.type}` });
    } catch (error) {
      client.connection.sendJson({ type: 'error', error: error?.message ?? String(error) });
    }
  }

  #handlePoll(res) {
    const wasConnected = this.connectionState;
    this.lastPollAt = Date.now();
    this.connectionState = true;
    if (!wasConnected) this.#emit({ type: 'extension', connected: true, at: this.lastPollAt });
    if (this.poll) {
      const previous = this.poll;
      this.poll = null;
      this.#endPoll(previous, []);
    }
    if (this.queue.length > 0) {
      this.#sendJson(res, 200, { commands: this.queue.splice(0) });
      return;
    }
    const pending = { res, timer: null };
    pending.timer = setTimeout(() => {
      if (this.poll === pending) this.poll = null;
      this.#endPoll(pending, []);
    }, this.pollTimeoutMs);
    this.poll = pending;
  }

  #handleExtensionEvent(body) {
    const event = { ...body, receivedAt: Date.now() };
    if (event.type === 'tab' && event.clientId && event.tabId !== undefined) {
      const lease = this.leases.leaseOf(String(event.clientId));
      if (lease && lease.tabId === null) this.bindLease(String(event.clientId), Number(event.tabId));
    }
    this.#emit({ type: 'extension-event', event });
  }

  #handleSse(req, res, clientId) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const client = { res, clientId: clientId ?? null };
    this.eventClients.add(client);
    this.#sendEvent(client, { type: 'hello', status: this.status(), history: this.history.slice(-50) });
    req.on('close', () => {
      this.eventClients.delete(client);
    });
  }

  #ensureConnected() {
    if (!this.connected) {
      if (this.connectionState) {
        this.connectionState = false;
        this.#emit({ type: 'extension', connected: false, at: Date.now() });
      }
      return {
        ok: false,
        text: 'The Nanobrowser extension is not connected to the hub. Load the extension built with WXT_BRIDGE=1, keep a normal page open in Chrome, and retry.',
      };
    }
    if (!this.connectionState) {
      this.connectionState = true;
      this.#emit({ type: 'extension', connected: true, at: Date.now() });
    }
    return null;
  }

  #enqueue(command) {
    this.queue.push(command);
    this.#flush();
  }

  #flush() {
    if (!this.poll || this.queue.length === 0) return;
    const pending = this.poll;
    this.poll = null;
    this.#endPoll(pending, this.queue.splice(0));
  }

  #endPoll(pending, commands) {
    clearTimeout(pending.timer);
    if (pending.res.writableEnded) return;
    try {
      pending.res.writeHead(200, { 'content-type': 'application/json' });
      pending.res.end(JSON.stringify({ commands }));
    } catch {
      /* the extension disconnected while answering */
    }
  }

  #settle(id, value) {
    const call = this.calls.get(id);
    if (!call) return false;
    this.calls.delete(id);
    call.settled = true;
    if (call.timer) clearTimeout(call.timer);
    if (call.signal && call.onAbort) call.signal.removeEventListener('abort', call.onAbort);
    try {
      call.resolve(value);
    } catch {
      /* the caller went away */
    }
    this.#emit({
      type: 'call-end',
      callId: id,
      clientId: call.clientId,
      ok: value?.ok !== false,
      ms: Math.max(0, Date.now() - (call.startedAt ?? Date.now())),
      text: summarizeResult(value),
    });
    return true;
  }

  #watchConnection() {
    if (this.connectionState && !this.connected) {
      this.connectionState = false;
      this.#emit({ type: 'extension', connected: false, at: Date.now() });
    }
  }

  #emit(event) {
    const payload = { at: Date.now(), ...event };
    this.history.push(payload);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    for (const listener of this.eventListeners ?? []) {
      try {
        listener(payload);
      } catch {
        /* one observer must not stop the others */
      }
    }
    for (const client of [...this.eventClients]) this.#sendEvent(client, payload);
    for (const client of [...this.wsClients]) {
      try {
        client.connection?.sendJson({ type: 'hub', event: payload });
      } catch {
        this.wsClients.delete(client);
      }
    }
  }

  #sendEvent(client, event) {
    try {
      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      this.eventClients.delete(client);
    }
  }

  #heartbeat() {
    for (const client of [...this.eventClients]) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        this.eventClients.delete(client);
      }
    }
  }

  #listen(server, port) {
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  #cors(res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type, x-nanobrowser-token');
    res.setHeader('cache-control', 'no-store');
  }

  #authorized(url, req) {
    const header = req.headers['x-nanobrowser-token'];
    const token = url.searchParams.get('token') ?? (Array.isArray(header) ? header[0] : header);
    return token === this.token;
  }

  #readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          reject(new Error('request body is too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (!body) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('request body is not JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  #sendJson(res, status, value) {
    if (res.writableEnded) return;
    try {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    } catch {
      /* the caller disconnected */
    }
  }

  #sendText(res, status, text) {
    if (res.writableEnded) return;
    try {
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(text);
    } catch {
      /* the caller disconnected */
    }
  }

  #log(...args) {
    const logger = this.logger;
    if (logger && typeof logger.info === 'function') logger.info('[nanobrowser-hub]', ...args);
    else if (logger && typeof logger.log === 'function') logger.log('[nanobrowser-hub]', ...args);
  }
}
