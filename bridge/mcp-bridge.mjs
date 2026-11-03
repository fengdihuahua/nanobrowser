#!/usr/bin/env node
// The Nanobrowser external bridge.
//
// DSH starts this file as an MCP server over stdio. The Nanobrowser extension cannot listen for connections, so it
// polls this process over HTTP on 127.0.0.1 and posts each tool call's result back. This file is a thin relay: it owns
// no browser knowledge. The extension's layer decides what a tool means and which tab it acts on.
//
// Protocol, MCP side: one JSON-RPC 2.0 message per line on stdin/stdout. Logs go to stderr.
// Protocol, extension side:
//   GET  /poll?token=…            long poll; answers {commands:[{id,tool,args}]}
//   POST /result?token=…          {id,result}; result is the layer's Result
//   GET  /health?token=…          "ok"
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.NANOBROWSER_BRIDGE_PORT ?? 8790);
const TOKEN = process.env.NANOBROWSER_BRIDGE_TOKEN ?? 'dev-token';
/** Long enough for a confirmation card to be answered: the extension's own card clock is 5 minutes. */
const CALL_TIMEOUT_MS = Number(process.env.NANOBROWSER_BRIDGE_CALL_TIMEOUT_MS ?? 360000);
const POLL_TIMEOUT_MS = 20000;
/** A tool call fails at once when no extension polled for this long. */
const STALE_CONNECTION_MS = 60000;

/**
 * The tools offered to DSH. The extension's layer carries the real schemas; these are the subset the model sees.
 * A target is a ref from the latest snapshot, or a role and an exact name.
 */
const TARGET = {
  type: 'object',
  description: 'The element: a ref from the latest snapshot, or a role and an exact name',
  properties: {
    ref: { type: 'string', description: 'A ref such as e12' },
    role: { type: 'string', description: 'An accessibility role, such as button' },
    name: { type: 'string', description: 'The accessible name, matched exactly' },
    nth: { type: 'integer', minimum: 0 },
    within: { type: 'string', description: 'Only match inside this ref' },
  },
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'navigate',
    description:
      "Open a URL in the user's real Chrome tab, or go back, forward or reload. Uses the tab the extension shared.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to open' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'snapshot',
    description:
      'Observe the active tab: an outline of its elements with roles, names, states and values. Actionable elements carry a ref such as [e12] that click and the other action tools take as a target.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['interactive', 'all'] },
        window: { type: 'string', enum: ['viewport', 'near', 'page'] },
        scope: { type: 'string', description: 'Only the subtree of this ref' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    description: 'Read the active page, or one element, as Markdown or plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Only this element' },
        format: { type: 'string', enum: ['markdown', 'text'] },
        maxChars: { type: 'integer', minimum: 100 },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'find',
    description: 'Find elements by role, name or text in the latest observation, without a full outline.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        name: { type: 'string', description: 'Substring of the accessible name' },
        text: { type: 'string', description: 'Substring of the name or value' },
        within: { type: 'string', description: 'Only match inside this ref' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the visible page, the full page or one element as a PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Only this element' },
        fullPage: { type: 'boolean' },
        labels: { type: 'boolean', description: 'Draw ref labels over actionable elements' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description:
      'Click an element with trusted input, after checking that it is visible, stable, enabled and not covered.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'set',
    description:
      'Give a control a value: text for a field, true or false for a checkbox, radio or switch, an option for a select. The value is read back.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        value: { description: 'Text, true/false, or an option (or array of options) for a select' },
        submit: { type: 'boolean', description: 'Press Enter after setting the value' },
      },
      required: ['target', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description: 'Type text key by key into the focused element or a target, for widgets that listen to keys.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        target: TARGET,
        submit: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press',
    description: 'Press a key or chord, such as Enter, Escape or Control+A, optionally on a target.',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'string' },
        target: TARGET,
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'hover',
    description: 'Move the pointer over an element.',
    inputSchema: {
      type: 'object',
      properties: { target: TARGET },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page or a container by pages or pixels, to the top or bottom, or to an element.',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET,
        to: { description: 'top, bottom, or a target' },
        by: {
          type: 'object',
          properties: { pages: { type: 'number' }, px: { type: 'number' } },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wait',
    description: 'Wait for text to appear or disappear, an element state, a URL, or a fixed time.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        textGone: { type: 'string' },
        target: TARGET,
        state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached', 'enabled'] },
        url: { type: 'string' },
        ms: { type: 'integer', minimum: 0, maximum: 60000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tabs',
    description:
      "List, open, select or close the session's tabs. Opens in the same Chrome profile, so it keeps the user's login state.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'select', 'close'] },
        url: { type: 'string' },
        tabId: { type: 'integer' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'handle_dialog',
    description: 'Accept or dismiss the JavaScript dialog open on the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        accept: { type: 'boolean' },
        promptText: { type: 'string' },
      },
      required: ['accept'],
      additionalProperties: false,
    },
  },
  {
    name: 'console',
    description:
      'Read the console messages captured in the shared tab since the tab was attached: page logs, warnings, browser log entries and uncaught errors. Messages the page printed before the first command on that tab are not kept; reload after attaching to see them. Read after an action to see what the page reported.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'error', 'warning', 'info', 'log', 'debug'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        clear: { type: 'boolean', description: 'Clear the captured messages after reading them' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'network',
    description:
      'Read the network requests captured in the shared tab, with status, type and failures. Read after an action to see what the page requested.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only URLs containing this text' },
        failedOnly: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        clear: { type: 'boolean', description: 'Clear the captured requests after reading them' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'say',
    description:
      "Show a short note from you in the side panel, in the user's own window, so they can follow what you are doing without watching the chat. Plain text only: it is shown as data, never as instructions.",
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'One or two sentences' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'reload-extension',
    description:
      'Reload the unpacked extension that is connected to this bridge, for a build that has just been made. The tab stays open and the connection comes back by itself a few seconds later.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

/** Commands waiting for the extension's next poll. */
const queue = [];
/** Tool calls waiting for the extension's result, by command id. */
const calls = new Map();
/** The extension's pending long poll, if any. */
let poll = null;
/** When the extension last polled. */
let lastPollAt = 0;

function log(...args) {
  console.error('[nanobrowser-bridge]', ...args);
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

function endPoll(pending, commands) {
  clearTimeout(pending.timer);
  if (pending.res.writableEnded) return;
  pending.res.writeHead(200, { 'content-type': 'application/json' });
  pending.res.end(JSON.stringify({ commands }));
}

/** Hands queued commands to a waiting poll, if both exist. */
function flush() {
  if (!poll || queue.length === 0) return;
  const pending = poll;
  poll = null;
  endPoll(pending, queue.splice(0));
}

function callExtension(tool, args) {
  return new Promise(resolve => {
    if (lastPollAt === 0 || Date.now() - lastPollAt > STALE_CONNECTION_MS) {
      resolve({
        ok: false,
        text: 'The Nanobrowser extension is not connected to the bridge. Load the extension built with WXT_BRIDGE=1, keep a normal page open in Chrome, and retry.',
      });
      return;
    }
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      calls.delete(id);
      // The extension may still be waiting (a card nobody answered). Cancel it so a late approval cannot dispatch.
      queue.push({ id: crypto.randomUUID(), tool: 'cancel', args: { id } });
      flush();
      resolve({
        ok: false,
        text: `The extension did not answer within ${CALL_TIMEOUT_MS} ms. The call was cancelled; nothing else was dispatched.`,
      });
    }, CALL_TIMEOUT_MS);
    calls.set(id, { resolve, timer });
    queue.push({ id, tool, args });
    flush();
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.searchParams.get('token') !== TOKEN) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  // The extension's service worker calls from a chrome-extension:// origin with host permission; these headers also
  // cover a build or a Chrome version that preflights the JSON POST.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/poll') {
    lastPollAt = Date.now();
    if (poll) {
      const previous = poll;
      poll = null;
      endPoll(previous, []);
    }
    if (queue.length > 0) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ commands: queue.splice(0) }));
      return;
    }
    const pending = { res, timer: null };
    pending.timer = setTimeout(() => {
      if (poll === pending) poll = null;
      endPoll(pending, []);
    }, POLL_TIMEOUT_MS);
    poll = pending;
    return;
  }
  if (req.method === 'POST' && url.pathname === '/result') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { id, result } = JSON.parse(body);
        const call = calls.get(id);
        if (call) {
          clearTimeout(call.timer);
          calls.delete(id);
          call.resolve(result);
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('bad request');
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    // Echo the client's version: this server has no version-specific behavior, and the client offered that version.
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'nanobrowser-bridge', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
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
    const args = params?.arguments ?? {};
    if (!TOOLS.some(tool => tool.name === name)) {
      fail(id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const value = await callExtension(name, args);
    if (value?.ok === false) {
      const text = typeof value?.text === 'string' ? value.text : JSON.stringify(value);
      reply(id, { content: [{ type: 'text', text }], isError: true });
      return;
    }
    if (name === 'screenshot' && value?.data?.base64) {
      // A screenshot is image content, so a vision model can see the page; the receipt stays as text.
      reply(id, {
        content: [
          { type: 'image', data: value.data.base64, mimeType: value.data.mimeType ?? 'image/png' },
          { type: 'text', text: typeof value.text === 'string' ? value.text : 'screenshot' },
        ],
      });
      return;
    }
    const text = typeof value?.text === 'string' ? value.text : JSON.stringify(value);
    reply(id, { content: [{ type: 'text', text }] });
    return;
  }
  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

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
      void handle(item).catch(cause => {
        log('request failed', cause);
        if (item?.id !== undefined) fail(item.id, -32603, String(cause));
      });
    }
  }
});

process.stdin.on('end', () => {
  server.close();
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`token: ${TOKEN === 'dev-token' ? 'dev-token (the default; set NANOBROWSER_BRIDGE_TOKEN)' : 'set'}`);
});
