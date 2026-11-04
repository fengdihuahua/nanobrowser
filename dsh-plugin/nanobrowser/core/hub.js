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
import { TOOL_NAMES, needsLease } from './tools.js';
import { LeaseManager } from './leases.js';
import { WsConnection } from './ws.js';

const DEFAULT_PORT = 8790;
const DEFAULT_TOKEN = 'dev-token';
const DEFAULT_CALL_TIMEOUT_MS = 360_000;
const POLL_TIMEOUT_MS = 20_000;
const STALE_CONNECTION_MS = 60_000;
const MAX_BODY_BYTES = 1_000_000;
const MAX_HISTORY = 200;
/** How much of a failed result is kept for the live context. The layer's own text is what the model needs, not a line. */
const MAX_FAILURE_CHARS = 1200;

const NO_LEASE =
  'This client owns no browser tab. Attach to one first: nanobrowser_attach in DSH, or POST /client/lease with a tabId.';

/** The refusal, shaped like a layer error so a runner can report a code instead of only a sentence. */
const NO_LEASE_ERROR = {
  code: 'NO_LEASE',
  message: NO_LEASE,
  delivered: false,
  hint: 'Attach to a tab, then call the tool again.',
};

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
    // When the extension came back, and when it went quiet: a page shows "2 s ago", not only on or off.
    this.connectedAt = null;
    this.disconnectedAt = null;
    this.eventClients = new Set();
    this.history = [];
    this.lastTabs = new Map();
    this.lastFailures = new Map();
    this.pageContexts = new Map();
    this.lastRuns = new Map();
    this.chatService = null;
    this.taskService = null;
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
        this.watchdog = setInterval(() => this.checkConnection(), 5_000);
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
    this.lastTabs.clear();
    this.lastFailures.clear();
    this.pageContexts.clear();
    this.lastRuns.clear();
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
    this.lastTabs.delete(String(clientId));
    this.lastFailures.delete(String(clientId));
    const released = this.leases.release(String(clientId));
    if (released) this.#emit({ type: 'lease', clientId: String(clientId), lease: null, released: true });
    return released;
  }

  /**
   * Queues one tool call and resolves with the layer's Result. `callId` lets an MCP adapter correlate a JSON-RPC
   * request with its cancellation; without it the hub mints one.
   */
  call(clientId, tool, args = {}, options = {}) {
    const client = String(clientId ?? 'anonymous');
    // Policy first: a call that will never be dispatched must not flip the connection state or reach the queue. A lease
    // whose tab is not known yet owns nothing, so it cannot authorize an action either.
    if (needsLease(tool, args) && this.leases.ownedTabId(client) === null) {
      return Promise.resolve({ ok: false, error: { ...NO_LEASE_ERROR }, text: NO_LEASE });
    }
    const disconnected = this.#ensureConnected();
    if (disconnected) return Promise.resolve(disconnected);
    const signal = options.signal;
    if (signal?.aborted) return Promise.resolve({ ok: false, text: 'The call was cancelled.' });
    const id = options.callId ? String(options.callId) : randomUUID();
    if (this.calls.has(id)) return Promise.resolve({ ok: false, text: `A call with id "${id}" is already running.` });
    const timeoutMs = Number(options.timeoutMs ?? this.callTimeoutMs);
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

  /**
   * Takes a tab for a client: ownership first, then an empty lease, then the extension's attach, then the bind. Until the
   * bind the client owns nothing, so a failure part way leaves it unable to act on any tab. Returns the HTTP status the
   * control route would use, so a caller without HTTP (a task being started) can map it to its own error.
   */
  async ownTab(clientId, tabId, { sessionId = null, kind = 'client' } = {}) {
    const owner = this.leases.ownerOf(tabId);
    if (owner && owner.clientId !== clientId) {
      return {
        ok: false,
        status: 409,
        error: `tab ${tabId} is leased by ${owner.clientId}`,
        owner: { clientId: owner.clientId, since: owner.since },
      };
    }
    const acquired = this.acquireLease(clientId, { sessionId, kind });
    if (!acquired.ok) {
      return { ok: false, status: 409, error: `could not lease a tab: ${acquired.reason}` };
    }
    // A lease this call created is dropped again if the attach or the bind fails, so it leaves nothing behind.
    const dropIfNew = () => {
      if (!acquired.reused) this.releaseLease(clientId);
    };
    const attached = await this.call(clientId, 'attach', { tabId });
    if (!attached || attached.ok === false) {
      dropIfNew();
      return { ok: false, status: 502, error: attached?.text ?? `could not attach to tab ${tabId}` };
    }
    const bound = this.bindLease(clientId, tabId);
    if (!bound.ok) {
      dropIfNew();
      return {
        ok: false,
        status: 409,
        error:
          bound.reason === 'tab-leased'
            ? `tab ${tabId} is leased by ${bound.owner?.clientId ?? 'another client'}`
            : `could not bind tab ${tabId}: ${bound.reason}`,
      };
    }
    return { ok: true, tabId, lease: bound.lease };
  }

  /**
   * Gives a tab back the whole way: the extension's session drops it (and its debugger) first, then the lease goes.
   * Releasing the lease alone left the layer holding the tab, so the next client's attach could not take it.
   */
  async releaseTab(clientId) {
    const id = String(clientId);
    for (const tabId of this.leases.tabsOf(id)) await this.call(id, 'unshare', { tabId });
    return this.releaseLease(id);
  }

  /** Gives one tab back and keeps the rest: detaching a single tab of a task. */
  async releaseOneTab(clientId, tabId) {
    const id = String(clientId);
    if (this.leases.tabsOf(id).includes(Number(tabId))) await this.call(id, 'unshare', { tabId: Number(tabId) });
    const released = this.leases.giveBack(id, Number(tabId));
    // The panel and the other clients learn that the task is one tab smaller, the same way they learn about any lease.
    if (released) this.#emit({ type: 'lease', clientId: id, lease: this.leases.leaseOf(id) ?? null, released: true });
    return released;
  }

  releaseLease(clientId) {
    const released = this.leases.release(String(clientId));
    if (released) this.#emit({ type: 'lease', clientId: String(clientId), lease: null, released: true });
    return released;
  }

  leaseOf(clientId) {
    return this.leases.leaseOf(String(clientId));
  }

  /** The tab this client was last given, or null when it holds none yet. */
  ownedTabId(clientId) {
    return this.leases.ownedTabId(String(clientId));
  }

  /** Every tab this client owns, oldest first. */
  tabsOf(clientId) {
    return this.leases.tabsOf(String(clientId));
  }

  /**
   * Where a client was last seen: the tab the extension reported with its last result, not the lease. The two drift
   * apart (a tab the page opened, a lease not yet bound), and the difference is worth showing.
   */
  lastTabOf(clientId) {
    return this.lastTabs.get(String(clientId));
  }

  /** Where the page context a session last sent came from, so the prompt can say when the tab has moved on. */
  rememberPageContext(clientId, origin) {
    const id = String(clientId ?? '');
    if (!origin || typeof origin !== 'object') return;
    this.pageContexts.set(id, { url: String(origin.url ?? ''), title: String(origin.title ?? ''), at: Date.now() });
  }

  pageContextOf(clientId) {
    return this.pageContexts.get(String(clientId));
  }

  /** Remembers how the last skill run ended, so the prompt can say where the run stopped without the model asking. */
  rememberRun(clientId, run) {
    const id = String(clientId ?? '');
    if (!run || typeof run !== 'object') return;
    this.lastRuns.set(id, { ...run, at: Date.now() });
  }

  /** The last skill run of this client: `{name, outcome, failedStep?, code?}`. */
  lastRunOf(clientId) {
    return this.lastRuns.get(String(clientId));
  }

  /** The text of this client's most recent failed call, or undefined when the last one worked. */
  lastFailureOf(clientId) {
    return this.lastFailures.get(String(clientId));
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
      connectedAt: this.connectedAt,
      disconnectedAt: this.disconnectedAt,
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
        // The tab the extension reported with the result: the audit can be read per page, not only per session.
        if (Number.isInteger(event.tabId)) call.tabId = event.tabId;
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

  /**
   * The service that starts a task from the browser. It lives in the plugin, not the hub: creating a session needs DSH,
   * and a hub without DSH is only a browser connection.
   */
  setTaskService(service) {
    this.taskService = service;
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
    // Before anything else: a browser sends the page's own origin with a request made from a web page, and this hub is
    // for the extension and for programs on this machine. The token is public (`dev-token`), so this is what stops a
    // page from driving the browser through a request the user never saw.
    if (this.#fromWebPage(req)) {
      this.#sendText(res, 403, 'a web page may not drive this hub');
      return;
    }
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
      const call = this.calls.get(id);
      if (call) this.#remember(call.clientId, body.tab, result);
      const tabId = body.tab && Number.isInteger(Number(body.tab.tabId)) ? Number(body.tab.tabId) : undefined;
      const settled = this.#settle(id, result, tabId);
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
          ? { ok: true, released: await this.releaseTab(clientId) }
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
      this.#sendJson(res, 200, { ok: true, released: await this.releaseTab(clientId) });
      return;
    }
    // The control routes: how a client that is not the DSH plugin takes a tab. `attach` and `tabs-all` are plugin
    // tools, so `/client/call` rejects them; these two give every front end the same way in.
    if (req.method === 'GET' && path === '/client/tabs') {
      if (!this.connected) {
        this.#sendJson(res, 503, { ok: false, error: 'the extension is not connected to the hub' });
        return;
      }
      const clientId = String(url.searchParams.get('clientId') ?? '') || 'anonymous';
      const result = await this.call(clientId, 'tabs-all', {});
      if (!result || result.ok === false) {
        this.#sendJson(res, 502, { ok: false, error: result?.text ?? 'could not list tabs' });
        return;
      }
      const tabs = (Array.isArray(result.data?.tabs) ? result.data.tabs : []).map(tab => {
        const owner = this.leases.ownerOf(Number(tab.tabId));
        return { ...tab, owner: owner ? { clientId: owner.clientId, since: owner.since } : null };
      });
      this.#sendJson(res, 200, { ok: true, tabs });
      return;
    }
    if (req.method === 'POST' && path === '/client/tab') {
      const body = await this.#readBody(req);
      const clientId = String(body.clientId ?? '');
      const tabId = Number(body.tabId);
      if (!clientId) {
        this.#sendJson(res, 400, { ok: false, error: 'clientId is required' });
        return;
      }
      if (!Number.isInteger(tabId) || tabId <= 0) {
        this.#sendJson(res, 400, { ok: false, error: 'tabId must be a positive integer' });
        return;
      }
      const taken = await this.ownTab(clientId, tabId, {
        sessionId: body.sessionId ?? null,
        kind: body.kind ?? 'client',
      });
      if (!taken.ok) {
        this.#sendJson(res, taken.status ?? 409, {
          ok: false,
          error: taken.error,
          ...(taken.owner ? { owner: taken.owner } : {}),
        });
        return;
      }
      this.#sendJson(res, 200, { ok: true, tabId: taken.tabId, lease: taken.lease });
      return;
    }
    // One tab back, the rest of the task kept: the panel's chip for a page the user is done with. The page itself stays
    // open; it is only no longer the task's to drive.
    if (req.method === 'POST' && path === '/client/tab/release') {
      const body = await this.#readBody(req);
      const clientId = String(body.clientId ?? '');
      const tabId = Number(body.tabId);
      if (!clientId) {
        this.#sendJson(res, 400, { ok: false, error: 'clientId is required' });
        return;
      }
      if (!Number.isInteger(tabId) || tabId <= 0) {
        this.#sendJson(res, 400, { ok: false, error: 'tabId must be a positive integer' });
        return;
      }
      const released = await this.releaseOneTab(clientId, tabId);
      this.#sendJson(res, released ? 200 : 404, {
        ok: released,
        ...(released ? {} : { error: `tab ${tabId} is not in ${clientId}'s lease` }),
      });
      return;
    }
    if (req.method === 'POST' && path === '/client/task') {
      if (!this.taskService) {
        this.#sendJson(res, 503, { ok: false, error: 'starting a task needs the DSH plugin' });
        return;
      }
      const body = await this.#readBody(req);
      try {
        this.#sendJson(res, 200, { ok: true, ...(await this.taskService.create(body)) });
      } catch (error) {
        this.#sendJson(res, Number(error?.status ?? 400), {
          ok: false,
          error: error?.message ?? String(error),
          ...(error?.owner ? { owner: error.owner } : {}),
        });
      }
      return;
    }
    // A read of what the hub has already done: for a front end that has no other way to show it, and for a client that
    // is asked "what happened before this".
    if (req.method === 'GET' && path === '/client/audit') {
      const clientId = url.searchParams.get('clientId');
      const limit = Number(url.searchParams.get('limit') ?? 20);
      this.#sendJson(res, 200, { ok: true, calls: this.audit(clientId ?? undefined, limit), status: this.status() });
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
    if (this.#fromWebPage(req)) {
      this.#rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
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
    const client = {
      connection: null,
      sessionId: url.searchParams.get('sessionId'),
      tabId: url.searchParams.get('tabId'),
    };
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
      const hello = await this.chatService.hello(client.sessionId, client.tabId);
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
    if (!wasConnected) {
      this.connectedAt = this.lastPollAt;
      this.#emit({ type: 'extension', connected: true, at: this.lastPollAt });
    }
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

  /**
   * Keeps what the prompt needs to say where a session is and why its last call failed. The audit trail stays bounded;
   * this is one tab and one failure per client.
   */
  #remember(clientId, tab, result) {
    const id = String(clientId ?? 'anonymous');
    if (tab && typeof tab === 'object' && Number.isInteger(Number(tab.tabId))) {
      this.lastTabs.set(id, {
        tabId: Number(tab.tabId),
        url: String(tab.url ?? ''),
        title: String(tab.title ?? ''),
        at: Date.now(),
      });
    }
    if (result?.ok === false) {
      const text = typeof result.text === 'string' ? result.text : '';
      if (text) {
        this.lastFailures.set(id, { text: text.slice(0, MAX_FAILURE_CHARS), at: Date.now() });
      }
    } else {
      // A call that worked clears the old failure: the prompt must not keep saying why something failed days ago.
      this.lastFailures.delete(id);
    }
  }

  /**
   * What the extension saw happen on its own: a tab joined a session, a tab closed, a page navigated. The hub keeps the
   * lease in step with it, so a task's tabs and its lease do not drift apart between commands.
   */
  #handleExtensionEvent(body) {
    const event = { ...body, receivedAt: Date.now() };
    const clientId = event.clientId ? String(event.clientId) : '';
    const tabId = event.tabId === undefined ? null : Number(event.tabId);
    if (clientId && tabId !== null && Number.isInteger(tabId)) {
      if (event.type === 'tab') {
        // A page opened a tab and the session adopted it: it is this task's tab from now on. Binding twice is free.
        if (this.leases.leaseOf(clientId)) this.bindLease(clientId, tabId);
      } else if (event.type === 'tab-closed') {
        // A closed tab must not stay in the lease: nothing can act on it any more.
        this.leases.giveBack(clientId, tabId);
        if (!this.leases.leaseOf(clientId)) this.#emit({ type: 'lease', clientId, lease: null, released: true });
        else this.#emit({ type: 'lease', clientId, lease: this.leases.leaseOf(clientId) });
      }
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

  #settle(id, value, tabId) {
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
      ...(Number.isInteger(Number(tabId)) ? { tabId: Number(tabId) } : {}),
    });
    return true;
  }

  /** Notices the extension going quiet. The watchdog calls it every few seconds; a test calls it when it wants to. */
  checkConnection() {
    if (this.connectionState && !this.connected) {
      this.connectionState = false;
      this.disconnectedAt = Date.now();
      this.#emit({ type: 'extension', connected: false, at: this.disconnectedAt });
    }
    return this.connected;
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
    // A task's tabs live in the hub's leases: when one changes, the panel's list of sessions is out of date, so it is
    // sent again. That is what keeps a task's chips and its tab group following a page the task opened on its own.
    if (payload.type === 'lease') this.#pushSessions();
  }

  /** The session list as a panel shows it, with each task's tabs, sent to every panel the hub is driving. */
  #pushSessions() {
    if (this.wsClients.size === 0 || !this.chatService) return;
    let sessions;
    try {
      sessions = this.chatService.sessions();
    } catch {
      return;
    }
    // A service may hand back a promise; the hub does not wait for one to keep its own event loop free.
    if (sessions && typeof sessions.then === 'function')
      sessions.then(list => this.#sendSessions(list)).catch(() => {});
    else this.#sendSessions(sessions);
  }

  #sendSessions(sessions) {
    for (const client of [...this.wsClients]) {
      try {
        client.connection?.sendJson({ type: 'sessions', sessions });
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

  /** Whether a request came from a web page: its origin is http(s), whoever the page is. */
  #fromWebPage(req) {
    return /^https?:/i.test(String(req.headers.origin ?? ''));
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
