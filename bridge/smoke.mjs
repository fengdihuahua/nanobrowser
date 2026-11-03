#!/usr/bin/env node
// A smoke test for the bridge without Chrome: one MCP client over stdio, one fake extension over HTTP.
// Run: node bridge/smoke.mjs
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import readline from 'node:readline';

const PORT = 8791;
const TOKEN = 'smoke-token';
const BASE = `http://127.0.0.1:${PORT}`;

const bridge = spawn(process.execPath, ['mcp-bridge.mjs'], {
  cwd: import.meta.dirname,
  env: {
    ...process.env,
    NANOBROWSER_BRIDGE_PORT: String(PORT),
    NANOBROWSER_BRIDGE_TOKEN: TOKEN,
    NANOBROWSER_BRIDGE_CALL_TIMEOUT_MS: '10000',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const lines = readline.createInterface({ input: bridge.stdout });
const waiting = new Map();
let nextId = 0;

lines.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = waiting.get(message.id);
  if (resolve) {
    waiting.delete(message.id);
    resolve(message);
  }
});

function request(method, params) {
  const id = ++nextId;
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 10_000);
    waiting.set(id, message => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForBridge() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${BASE}/health?token=${TOKEN}`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await delay(100);
  }
  throw new Error('the bridge did not start');
}

let stopped = false;
async function fakeExtension() {
  while (!stopped) {
    try {
      const response = await fetch(`${BASE}/poll?token=${TOKEN}`, { signal: AbortSignal.timeout(25_000) });
      if (!response.ok) {
        await delay(100);
        continue;
      }
      const { commands } = await response.json();
      for (const command of commands) {
        await fetch(`${BASE}/result?token=${TOKEN}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: command.id, result: { ok: true, text: `${command.tool} ok` } }),
        });
      }
    } catch {
      await delay(100);
    }
  }
}

try {
  await waitForBridge();
  void fakeExtension();
  // Let the fake extension's first poll reach the bridge before a tool call.
  await delay(300);

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bridge-smoke', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools, 'the server advertises tools');
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await request('tools/list', {});
  const names = list.result.tools.map(tool => tool.name);
  assert.ok(names.includes('navigate'), 'navigate is offered');
  assert.ok(names.includes('snapshot'), 'snapshot is offered');
  assert.ok(names.includes('click'), 'click is offered');
  assert.ok(names.includes('set'), 'set is offered');
  assert.ok(names.includes('tabs'), 'tabs is offered');

  const snapshot = await request('tools/call', { name: 'snapshot', arguments: {} });
  assert.equal(snapshot.result.content[0].text, 'snapshot ok');
  assert.ok(!snapshot.result.isError);

  const click = await request('tools/call', { name: 'click', arguments: { target: { ref: 'e1' } } });
  assert.equal(click.result.content[0].text, 'click ok');

  const unknown = await request('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknown.error.code, -32602);

  console.log('bridge smoke: ok');
  await stop();
  process.exit(0);
} catch (error) {
  console.error('bridge smoke: failed', error);
  await stop();
  process.exit(1);
}

/** Closes the bridge's stdin (it exits on end) and waits for it, so no pipe is still closing at exit. */
async function stop() {
  stopped = true;
  lines.close();
  bridge.stdin.end();
  await Promise.race([new Promise(resolve => bridge.once('exit', resolve)), delay(2000)]);
}
