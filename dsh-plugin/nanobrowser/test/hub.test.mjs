// The hub's contract without Chrome: a fake extension polls, answers and can be made to stall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../core/hub.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error('timed out waiting for the condition');
}

async function startHub(t, options = {}) {
  const hub = new Hub({ port: 0, token: 'test-token', pollTimeoutMs: 100, ...options });
  await hub.start({ retryMs: 50 });
  t.after(() => hub.stop());
  return hub;
}

/** A poll loop that answers normally, stalls every call, or stalls only the first one. */
function fakeExtension(hub, { mode = 'answer' } = {}) {
  const base = `http://127.0.0.1:${hub.port}`;
  const token = encodeURIComponent(hub.token);
  const controller = new AbortController();
  const seen = [];
  let calls = 0;
  const post = (path, body) =>
    fetch(`${base}${path}?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  const done = (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`${base}/poll?token=${token}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`poll answered ${response.status}`);
        const body = await response.json();
        for (const command of body.commands ?? []) {
          seen.push(command);
          if (command.tool === 'cancel') {
            await post('/result', { id: command.id, result: { ok: true, text: 'cancelled' } });
            continue;
          }
          calls += 1;
          const stall = mode === 'stall' || (mode === 'stall-first' && calls === 1);
          if (stall) continue;
          await post('/result', { id: command.id, result: { ok: true, text: `${command.tool} ok` } });
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        throw error;
      }
    }
  })();
  return {
    seen,
    stop() {
      controller.abort();
      return done.catch(() => undefined);
    },
  };
}

test('a call before the extension connects fails fast', async t => {
  const hub = await startHub(t);
  const result = await hub.call('test', 'snapshot', {});
  assert.equal(result.ok, false);
  assert.match(result.text, /not connected/i);
});

test('a call is queued for the extension and its result comes back', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const result = await hub.call('test', 'snapshot', { mode: 'interactive' });
  assert.deepEqual(result, { ok: true, text: 'snapshot ok' });
  const command = extension.seen.find(item => item.tool === 'snapshot');
  assert.equal(command.clientId, 'test');
  assert.equal(command.args.mode, 'interactive');
  await extension.stop();
});

test('leases are exclusive per tab and release cleanly', async t => {
  const hub = await startHub(t);
  const first = hub.acquireLease('session-a', { tabId: 12, sessionId: 'session-a', kind: 'dsh' });
  assert.equal(first.ok, true);
  assert.equal(first.lease.tabId, 12);
  const second = hub.acquireLease('session-b', { tabId: 12, sessionId: 'session-b', kind: 'dsh' });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'tab-leased');
  assert.equal(hub.leaseOf('session-a').tabId, 12);
  assert.equal(hub.releaseLease('session-a'), true);
  assert.equal(hub.leaseOf('session-a'), undefined);
  assert.equal(hub.ownerOf(12), undefined);
  const third = hub.acquireLease('session-b', { tabId: 12 });
  assert.equal(third.ok, true);
});

test('a lease can be acquired before its tab is known, then bound', async t => {
  const hub = await startHub(t);
  const lease = hub.acquireLease('session-a', { sessionId: 'session-a' });
  assert.equal(lease.ok, true);
  assert.equal(lease.lease.tabId, null);
  const bound = hub.bindLease('session-a', 7);
  assert.equal(bound.ok, true);
  assert.equal(hub.ownerOf(7).clientId, 'session-a');
});

test('cancelling a call sends a cancel command and settles the caller', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub, { mode: 'stall' });
  await waitFor(() => hub.connected);
  const call = hub.call('test', 'click', { target: { role: 'button', name: 'Pay' } });
  await waitFor(() => extension.seen.some(item => item.tool === 'click'));
  const callId = extension.seen.find(item => item.tool === 'click').id;
  assert.equal(hub.cancel('test', callId), true);
  const result = await call;
  assert.equal(result.ok, false);
  assert.match(result.text, /cancelled/i);
  await waitFor(() => extension.seen.some(item => item.tool === 'cancel'));
  await extension.stop();
});

test('a call times out, cancels the extension, and reports it', async t => {
  const hub = await startHub(t, { callTimeoutMs: 120 });
  const extension = fakeExtension(hub, { mode: 'stall' });
  await waitFor(() => hub.connected);
  const result = await hub.call('test', 'wait', { text: 'never' });
  assert.equal(result.ok, false);
  assert.match(result.text, /did not answer within 120 ms/);
  await waitFor(() => extension.seen.some(item => item.tool === 'cancel'));
  await extension.stop();
});

test('a disconnecting extension flips the connection state', async t => {
  const hub = await startHub(t, { staleConnectionMs: 80 });
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  await extension.stop();
  await sleep(120);
  assert.equal(hub.connected, false);
  const result = await hub.call('test', 'snapshot', {});
  assert.equal(result.ok, false);
});

test('clients register and are visible in status', async t => {
  const hub = await startHub(t);
  const client = hub.registerClient({ clientId: 'session-a', kind: 'dsh', sessionId: 'session-a' });
  assert.equal(client.clientId, 'session-a');
  assert.equal(hub.status().clients.length, 1);
  assert.equal(hub.unregisterClient('session-a'), false);
});

test('audit pairs each call with its outcome', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  await hub.call('test', 'click', { target: { role: 'button', name: 'Go' } });
  const rows = hub.audit('test', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'click');
  assert.equal(rows[0].clientId, 'test');
  assert.equal(rows[0].ok, true);
  assert.deepEqual(rows[0].args, { target: '{…}' });
  assert.equal(typeof rows[0].ms, 'number');
  assert.equal(rows[0].text, 'click ok');
  assert.deepEqual(hub.audit('other', 5), []);
  await extension.stop();
});

test('the chat WebSocket handshakes, sends hello and dispatches a message', async t => {
  const hub = await startHub(t);
  const sent = [];
  hub.setChatService({
    async hello() {
      return {
        sessions: [{ id: 's1', title: 'Test', status: 'idle', running: false }],
        sessionId: 's1',
        history: { sessionId: 's1', live: true, messages: [{ kind: 'user', text: 'hi' }] },
      };
    },
    async sessions() {
      return [{ id: 's1', title: 'Test', status: 'idle', running: false }];
    },
    async history(sessionId) {
      return { sessionId, live: true, messages: [] };
    },
    async send(input) {
      sent.push(input);
      return { sessionId: input.sessionId, messageId: 'm1', mode: 'followup' };
    },
    async stop() {
      return { sessionId: 's1' };
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/client/chat/ws?token=test-token&sessionId=s1`);
  const messages = [];
  const closed = new Promise(resolve => {
    ws.onclose = resolve;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket test timed out')), 3000);
    ws.onerror = error => {
      clearTimeout(timer);
      reject(error);
    };
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      messages.push(message);
      if (message.type === 'hello') ws.send(JSON.stringify({ type: 'send', text: 'hello from the panel' }));
      if (message.type === 'sent') {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  const hello = messages.find(message => message.type === 'hello');
  assert.equal(hello.sessionId, 's1');
  assert.equal(hello.history.messages[0].text, 'hi');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'hello from the panel');
  ws.close();
  await closed;
});
