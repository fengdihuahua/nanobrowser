// Starting a task from a page (N1): the plugin creates the DSH session, takes the tab it came from, and sends the page
// with the first message. The route is the same one the side panel will call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../core/hub.js';
import { resolveConfig } from '../core/config.js';
import { registerTasks } from '../host/task.js';
import { fakeExtension, waitFor } from './fake-extension.mjs';

async function startHub(t) {
  const hub = new Hub({ port: 0, token: 'test-token', pollTimeoutMs: 100 });
  await hub.start({ retryMs: 50 });
  t.after(() => hub.stop());
  return hub;
}

/** A DSH context with the two services the task service uses, and a record of what it was asked to create. */
function fakeDsh({ selection = { provider: 'deepseek', model: 'deepseek-chat' }, creates = true } = {}) {
  const created = [];
  const sent = [];
  const ctx = {
    get: name => (name === 'agentDefaultModel' ? { currentSelection: () => selection } : undefined),
    agents: creates
      ? {
          async create(options) {
            created.push(options);
            const agent = {
              id: options.sessionId,
              status: 'idle',
              followup(message) {
                sent.push({ sessionId: options.sessionId, message });
              },
            };
            return { agent, dispose: async () => undefined };
          },
        }
      : undefined,
  };
  return { ctx, created, sent };
}

const url = (hub, path) => `http://127.0.0.1:${hub.port}${path}?token=test-token`;
const post = (hub, path, payload) =>
  fetch(url(hub, path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

test('a task creates the session, takes the tab and sends the page with the first message', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const dsh = fakeDsh({ selection: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } });
  const settings = resolveConfig({ port: hub.port, token: hub.token, taskCwd: '/tmp/tasks' });
  t.after(registerTasks(dsh.ctx, hub, settings));

  const response = await post(hub, '/client/task', { text: '查这张单', tabId: 5 });
  const task = await response.json();
  assert.equal(response.status, 200);
  assert.equal(task.ok, true);
  assert.equal(task.tabId, 5);
  assert.equal(task.cwd, '/tmp/tasks');
  assert.equal(task.model, 'deepseek/deepseek-chat');
  assert.equal(task.pageContext, true);

  // The session is the id the task returned, with the deployment's default model and the plugin's own cwd.
  assert.equal(dsh.created.length, 1);
  assert.equal(dsh.created[0].sessionId, task.sessionId);
  assert.deepEqual(dsh.created[0].agentOptions, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
  });
  assert.deepEqual(dsh.created[0].meta, { cwd: '/tmp/tasks' });

  // The tab belongs to the new session, and the page came with the message; the words are the user's.
  assert.equal(hub.ownedTabId(task.sessionId), 5);
  assert.equal(dsh.sent.length, 1);
  const text = dsh.sent[0].message.content[0].text;
  assert.match(text, /^<page_context /);
  // The page the task came from travels with the message: url, title, the selection, and the page itself.
  assert.match(text, /url="https:\/\/example\.test\/a"/);
  assert.match(text, /title="A"/);
  assert.match(text, /<selection>订单 1001<\/selection>/);
  assert.match(text, /合计 1,200\.00/);
  assert.match(text, /查这张单$/);
  assert.equal(dsh.sent[0].message.role, 'user');
  await extension.stop();
});

test('a tab another client holds is refused, and no session is created', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  hub.acquireLease('session-a', { tabId: 5 });
  const dsh = fakeDsh();
  const settings = resolveConfig({ port: hub.port, token: hub.token });
  t.after(registerTasks(dsh.ctx, hub, settings));

  const response = await post(hub, '/client/task', { text: '抢这一页', tabId: 5 });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /session-a/);
  assert.equal(dsh.created.length, 0);
  assert.equal(hub.ownedTabId('session-a'), 5);
  await extension.stop();
});

test('without a default model DSH is asked for nothing', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const dsh = fakeDsh({ selection: {} });
  const settings = resolveConfig({ port: hub.port, token: hub.token });
  t.after(registerTasks(dsh.ctx, hub, settings));

  const response = await post(hub, '/client/task', { text: '做点事', tabId: 5 });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /default model/i);
  assert.equal(dsh.created.length, 0);
  await extension.stop();
});

test('a bad request is refused before anything is created', async t => {
  const hub = await startHub(t);
  const dsh = fakeDsh();
  const settings = resolveConfig({ port: hub.port, token: hub.token });
  t.after(registerTasks(dsh.ctx, hub, settings));

  assert.equal((await post(hub, '/client/task', { text: '   ', tabId: 5 })).status, 400);
  assert.equal((await post(hub, '/client/task', { text: 'hi' })).status, 400);
  assert.equal((await post(hub, '/client/task', { text: 'hi', tabId: 'x' })).status, 400);
  assert.equal(dsh.created.length, 0);
});

test('the route says what is missing when no plugin is there to create a session', async t => {
  const hub = await startHub(t);
  const response = await post(hub, '/client/task', { text: 'hi', tabId: 5 });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /DSH plugin/);
});

test('a task may name its own model and directory, and the defaults still apply', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const dsh = fakeDsh({ selection: { provider: 'deepseek', model: 'deepseek-chat' } });
  const settings = resolveConfig({ port: hub.port, token: hub.token, taskCwd: '/tmp/tasks' });
  t.after(registerTasks(dsh.ctx, hub, settings));

  const route = await (await post(hub, '/client/task', { text: 'x', tabId: 5, model: 'other/big' })).json();
  assert.equal(route.model, 'other/big');
  assert.equal(dsh.created.at(-1).agentOptions.provider, 'other');
  assert.equal(dsh.created.at(-1).agentOptions.model, 'big');

  const elsewhere = await (await post(hub, '/client/task', { text: 'y', tabId: 6, cwd: '/tmp/other' })).json();
  assert.equal(elsewhere.cwd, '/tmp/other');
  assert.equal(dsh.created.at(-1).meta.cwd, '/tmp/other');
  await extension.stop();
});
