#!/usr/bin/env node
// A thin MCP front end for the Nanobrowser hub.
//
// It does not own the extension connection: it connects to a running hub (normally the DSH plugin's), or starts one
// when DSH is not running. Any MCP client that can spawn a stdio server can use it: Qoder, Claude Code, Cursor, ...
//
// Protocol, MCP side: one JSON-RPC 2.0 message per line on stdin/stdout. Logs go to stderr.
// Protocol, hub side: POST /client/register, /client/call, /client/cancel.

import { TOOLS } from '../core/tools.js';
import { Hub } from '../core/hub.js';

const PORT = Number(process.env.NANOBROWSER_BRIDGE_PORT ?? 8790);
const TOKEN = String(process.env.NANOBROWSER_BRIDGE_TOKEN ?? 'dev-token');
const BASE = `http://127.0.0.1:${PORT}`;
const CLIENT_ID = `mcp:nanobrowser:${process.pid}`;
const STARTUP_WAIT_MS = Number(process.env.NANOBROWSER_HUB_WAIT_MS ?? 3000);

let embeddedHub = null;
/** JSON-RPC request id -> controller that cancels the hub call. */
const running = new Map();

function log(...args) {
  console.error('[nanobrowser-mcp]', ...args);
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function fail(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function hubGet(path) {
  const response = await fetch(`${BASE}${path}?token=${encodeURIComponent(TOKEN)}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  return response.json();
}

async function hubPost(path, body, signal) {
  const response = await fetch(`${BASE}${path}?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`hub answered ${response.status}`);
  return response.json();
}

/** Connect to the hub that is already running, or own one for a client that runs without DSH. */
async function ensureHub() {
  const deadline = Date.now() + STARTUP_WAIT_MS;
  for (;;) {
    try {
      await hubGet('/health');
      return;
    } catch {
      if (Date.now() >= deadline) break;
      await sleep(200);
    }
  }
  embeddedHub = new Hub({
    port: PORT,
    token: TOKEN,
    logger: { info: log, error: log, log },
  });
  await embeddedHub.start({ retryMs: 2000 });
  log('started an embedded hub because no response came from', BASE);
}

async function register() {
  await ensureHub();
  try {
    await hubPost('/client/register', { clientId: CLIENT_ID, kind: 'mcp', sessionId: null });
  } catch (error) {
    log('registration failed:', error?.message ?? String(error));
  }
}

async function callTool(id, name, args) {
  const controller = new AbortController();
  running.set(String(id), controller);
  try {
    const payload = await hubPost(
      '/client/call',
      {
        clientId: CLIENT_ID,
        callId: `${CLIENT_ID}:${id}`,
        tool: name,
        args: args ?? {},
      },
      controller.signal,
    );
    const value = payload?.result;
    if (value?.ok === false) {
      reply(id, {
        content: [{ type: 'text', text: typeof value.text === 'string' ? value.text : JSON.stringify(value) }],
        isError: true,
      });
      return;
    }
    if (name === 'screenshot' && value?.data?.base64) {
      reply(id, {
        content: [
          { type: 'image', data: value.data.base64, mimeType: value.data.mimeType ?? 'image/png' },
          { type: 'text', text: typeof value.text === 'string' ? value.text : 'screenshot' },
        ],
      });
      return;
    }
    reply(id, {
      content: [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
    });
  } catch (error) {
    if (controller.signal.aborted) {
      reply(id, { content: [{ type: 'text', text: 'The call was cancelled.' }], isError: true });
      return;
    }
    fail(id, -32603, error?.message ?? String(error));
  } finally {
    running.delete(String(id));
  }
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'nanobrowser-hub', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'notifications/cancelled') {
    const requestId = String(params?.requestId ?? '');
    const controller = running.get(requestId);
    try {
      await hubPost('/client/cancel', { clientId: CLIENT_ID, callId: `${CLIENT_ID}:${requestId}` });
    } catch {
      /* the hub may already have settled the call */
    }
    controller?.abort();
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOLS.some(tool => tool.name === name)) {
      fail(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    await callTool(id, name, params?.arguments ?? {});
    return;
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

void register().catch(error => log('hub registration failed:', error?.message ?? String(error)));

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log('invalid JSON on stdin');
      continue;
    }
    for (const item of Array.isArray(message) ? message : [message]) {
      void handle(item).catch(error => {
        log('request failed:', error?.message ?? String(error));
        if (item?.id !== undefined) fail(item.id, -32603, String(error));
      });
    }
  }
});

process.stdin.on('end', () => {
  void embeddedHub?.stop().finally(() => process.exit(0));
});
