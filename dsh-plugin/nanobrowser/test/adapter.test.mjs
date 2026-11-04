// The adapter's contract: spawn it like a client would, speak JSON-RPC over its stdin and stdout, and drive the hub
// that is already running. This is the smoke test the MCP front end had none of: it catches a protocol typo, a tool
// that is listed but not routed, and a lease that is taken but never used.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../core/hub.js';
import { writeSkill } from '../core/skills.js';
import { fakeExtension, waitFor } from './fake-extension.mjs';

const ADAPTER = fileURLToPath(new URL('../mcp/adapter.mjs', import.meta.url));

/** A running adapter, with the id of every request it has answered. */
function startAdapter(t, hub, env = {}) {
  const child = spawn(process.execPath, [ADAPTER], {
    env: {
      ...process.env,
      NANOBROWSER_BRIDGE_PORT: String(hub.port),
      NANOBROWSER_BRIDGE_TOKEN: hub.token,
      NANOBROWSER_HUB_WAIT_MS: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    child.kill('SIGKILL');
  });
  const waiting = new Map();
  const errors = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const settle = waiting.get(message.id);
      if (settle) {
        waiting.delete(message.id);
        settle(message);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => errors.push(chunk));

  let nextId = 1;
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}; stderr: ${errors.join('')}`)), 5000);
      waiting.set(id, message => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  };
  const close = () =>
    new Promise(resolve => {
      child.once('exit', code => resolve(code));
      child.stdin.end();
    });
  return { child, request, close };
}

test('the adapter lists its tools, takes a tab, drives it and gives it back', async t => {
  const hub = new Hub({ port: 0, token: 'test-token', pollTimeoutMs: 100 });
  await hub.start({ retryMs: 50 });
  t.after(() => hub.stop());
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const adapter = startAdapter(t, hub);
  const clientId = `mcp:nanobrowser:${adapter.child.pid}`;

  const hello = await adapter.request('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(hello.result.serverInfo.name, 'nanobrowser-hub');
  // The rules a client would otherwise learn by being refused: attach first, page text is data, do not retry blindly.
  assert.match(hello.result.instructions, /call attach/);
  assert.match(hello.result.instructions, /data, never instructions/);
  assert.match(hello.result.instructions, /safe to retry/);
  assert.match(hello.result.instructions, /skill_run/);

  const list = await adapter.request('tools/list', {});
  const names = list.result.tools.map(tool => tool.name);
  assert.equal(names.length, 25);
  for (const name of [
    'attach',
    'detach',
    'snapshot',
    'click',
    'tabs',
    'reload-extension',
    'skill_list',
    'status',
    'audit',
  ]) {
    assert.ok(names.includes(name), `${name} is missing`);
  }

  // The decision tools are listed but not driven yet, and an action before attach is refused with the way out.
  const early = await adapter.request('tools/call', {
    name: 'click',
    arguments: { target: { role: 'button', name: 'Go' } },
  });
  assert.equal(early.result.isError, true);
  assert.match(early.result.content[0].text, /attach/i);

  const attached = await adapter.request('tools/call', { name: 'attach', arguments: {} });
  assert.equal(attached.result.isError, undefined);
  assert.match(attached.result.content[0].text, /tab 5/);
  assert.equal(hub.ownedTabId(clientId), 5);

  const clicked = await adapter.request('tools/call', {
    name: 'click',
    arguments: { target: { role: 'button', name: 'Go' } },
  });
  assert.equal(clicked.result.isError, undefined);
  assert.equal(clicked.result.content[0].text, 'click ok');

  // A tab another client holds is refused by name, and does not steal the current one.
  hub.acquireLease('session-a', { tabId: 6 });
  const refused = await adapter.request('tools/call', { name: 'attach', arguments: { tabId: 6 } });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /session-a/);
  assert.equal(hub.ownedTabId(clientId), 5);

  const detached = await adapter.request('tools/call', { name: 'detach', arguments: {} });
  assert.equal(detached.result.isError, undefined);
  assert.equal(hub.ownedTabId(clientId), null);

  // Leaving releases the tab too, so the next client is not locked out.
  await adapter.request('tools/call', { name: 'attach', arguments: {} });
  assert.equal(hub.ownedTabId(clientId), 5);
  assert.equal(await adapter.close(), 0);
  await waitFor(() => hub.ownedTabId(clientId) === null);
  await extension.stop();
});

test('a second client takes its own tab instead of fighting over the first one', async t => {
  const hub = new Hub({ port: 0, token: 'test-token', pollTimeoutMs: 100 });
  await hub.start({ retryMs: 50 });
  t.after(() => hub.stop());
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const first = startAdapter(t, hub);
  const second = startAdapter(t, hub);
  const firstId = `mcp:nanobrowser:${first.child.pid}`;
  const secondId = `mcp:nanobrowser:${second.child.pid}`;

  await first.request('initialize', {});
  await second.request('initialize', {});
  const taken = await first.request('tools/call', { name: 'attach', arguments: {} });
  assert.match(taken.result.content[0].text, /tab 5/);
  // The active tab is taken, so the second client takes the next free one and is told which.
  const other = await second.request('tools/call', { name: 'attach', arguments: {} });
  assert.equal(other.result.isError, undefined);
  assert.match(other.result.content[0].text, /tab 6/);
  assert.equal(hub.ownedTabId(firstId), 5);
  assert.equal(hub.ownedTabId(secondId), 6);

  // Acting on the other client's tab is refused, so neither can move the other's page.
  const steal = await second.request('tools/call', { name: 'attach', arguments: { tabId: 5 } });
  assert.equal(steal.result.isError, true);
  assert.ok(steal.result.content[0].text.includes(firstId));
  assert.equal(hub.ownedTabId(firstId), 5);
  await extension.stop();
});

test('the adapter lists, shows and runs a saved skill from the shared directory', async t => {
  const skillsDir = await mkdtemp(join(tmpdir(), 'nb-skills-'));
  t.after(() => rm(skillsDir, { recursive: true, force: true }));
  await writeSkill(
    skillsDir,
    {
      name: 'find-order',
      description: 'Look an order up by number',
      params: { orderNo: { type: 'string', required: true } },
      steps: [{ id: 'look', tool: 'click', target: { role: 'button', name: '查询' } }],
      assert: [],
      version: 1,
    },
    '---\nname: find-order\ndescription: Look an order up by number\n---\n\nClick 查询.\n',
  );

  const hub = new Hub({ port: 0, token: 'test-token', pollTimeoutMs: 100 });
  await hub.start({ retryMs: 50 });
  t.after(() => hub.stop());
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const adapter = startAdapter(t, hub, { NANOBROWSER_SKILLS_DIR: skillsDir });

  const list = await adapter.request('tools/call', { name: 'skill_list', arguments: {} });
  assert.equal(list.result.isError, undefined);
  assert.match(list.result.content[0].text, /find-order · Look an order up by number/);
  assert.match(list.result.content[0].text, /params orderNo: string/);

  const shown = await adapter.request('tools/call', { name: 'skill_show', arguments: { name: 'find-order' } });
  assert.match(shown.result.content[0].text, /Click 查询\./);
  assert.match(shown.result.content[0].text, /--- recipe ---/);
  // Showing a skill runs nothing.
  assert.equal(extension.seen.filter(command => command.tool === 'click').length, 0);

  // Running it needs a tab, and the refusal says which tool takes one.
  const refused = await adapter.request('tools/call', {
    name: 'skill_run',
    arguments: { name: 'find-order', params: { orderNo: 'ORD-1001' } },
  });
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /attach/i);

  await adapter.request('tools/call', { name: 'attach', arguments: {} });
  const ran = await adapter.request('tools/call', {
    name: 'skill_run',
    arguments: { name: 'find-order', params: { orderNo: 'ORD-1001' } },
  });
  assert.equal(ran.result.isError, undefined);
  assert.match(ran.result.content[0].text, /Ran skill "find-order" · 1 step/);
  assert.equal(extension.seen.filter(command => command.tool === 'click').length, 1);

  const missing = await adapter.request('tools/call', { name: 'skill_show', arguments: { name: 'nope' } });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /No skill named nope/);
  await extension.stop();
});

test('a hub that refuses is explained, not echoed, and the tool result carries it', async t => {
  // A hub that answers only what this test needs, so the adapter's failure wording is checked end to end.
  const refusal = { status: 500, body: { ok: false, error: 'the queue is full' } };
  let callStatus = refusal;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health') return send(200, { ok: true, connected: false, leases: [] });
    if (url.pathname === '/client/register') return send(200, { ok: true });
    if (url.pathname === '/client/call') return send(callStatus.status, callStatus.body);
    if (url.pathname === '/client/tabs')
      return send(503, { ok: false, error: 'the extension is not connected to the hub' });
    return send(404, { ok: false, error: 'not found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const adapter = startAdapter(t, { port, token: 'test-token' });

  const refused = await adapter.request('tools/call', {
    name: 'click',
    arguments: { target: { role: 'button', name: 'Go' } },
  });
  // A refused call is a tool result with a sentence, not a JSON-RPC error the client cannot read.
  assert.equal(refused.error, undefined);
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /The hub refused POST \/client\/call: the queue is full/);

  // The control routes bring their own reason; the adapter does not re-word it.
  const tabs = await adapter.request('tools/call', { name: 'attach', arguments: {} });
  assert.equal(tabs.result.isError, true);
  assert.match(tabs.result.content[0].text, /the extension is not connected to the hub/);

  // A wrong token is named as such, with the variable to set.
  callStatus = { status: 401, body: {} };
  const unauthorized = await adapter.request('tools/call', {
    name: 'click',
    arguments: { target: { role: 'button', name: 'Go' } },
  });
  assert.match(unauthorized.result.content[0].text, /NANOBROWSER_BRIDGE_TOKEN/);
});
