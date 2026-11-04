// The hub's contract without Chrome: a fake extension polls, answers and can be made to stall.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../core/hub.js';
import { fakeExtension, sleep, waitFor } from './fake-extension.mjs';

/** A hub on a free port, stopped after the test. */
async function startHub(t, options = {}) {
  const hub = new Hub({ port: 0, token: 'test-token', pollTimeoutMs: 100, ...options });
  await hub.start({ retryMs: 50 });
  t.after(() => hub.stop());
  return hub;
}

test('a call before the extension connects fails fast', async t => {
  const hub = await startHub(t);
  hub.acquireLease('test', { tabId: 4 });
  const result = await hub.call('test', 'click', { target: { role: 'button', name: 'Go' } });
  assert.equal(result.ok, false);
  assert.match(result.text, /not connected/i);
});

test('a request made from a web page is refused before it reaches the browser', async t => {
  const hub = await startHub(t);
  // The token is public (`dev-token` in a checkout); the origin is what stops a page from using it.
  const fromPage = await fetch(`http://127.0.0.1:${hub.port}/client/call?token=test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.test' },
    body: JSON.stringify({ clientId: 'page', tool: 'snapshot' }),
  });
  assert.equal(fromPage.status, 403);
  assert.match(await fromPage.text(), /web page/i);
  // The browser's preflight is refused too, so a page cannot even ask.
  const preflight = await fetch(`http://127.0.0.1:${hub.port}/client/call?token=test-token`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.status, 403);

  // A program on this machine sends no origin; an extension page is not a web page.
  assert.equal((await fetch(`http://127.0.0.1:${hub.port}/health?token=test-token`)).status, 200);
  const fromExtension = await fetch(`http://127.0.0.1:${hub.port}/health?token=test-token`, {
    headers: { origin: 'chrome-extension://abcdefghijklmnop' },
  });
  assert.equal(fromExtension.status, 200);
});

test('the hub says since when the extension is connected, and when it went quiet', async t => {
  const hub = await startHub(t, { staleConnectionMs: 50 });
  const before = hub.status();
  assert.equal(before.connected, false);
  assert.equal(before.connectedAt, null);
  assert.equal(before.disconnectedAt, null);

  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const up = hub.status();
  assert.equal(up.connected, true);
  assert.equal(typeof up.connectedAt, 'number');
  assert.equal(up.disconnectedAt, null);

  // The extension stops polling: the watchdog's own check is what notices, and it is callable on its own.
  await extension.stop();
  await sleep(120);
  assert.equal(hub.checkConnection(), false);
  const down = hub.status();
  assert.equal(down.connected, false);
  assert.equal(typeof down.disconnectedAt, 'number');
  assert.equal(down.connectedAt, up.connectedAt);
});

test('a page-changing call without a lease is refused, and observation is not', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const refused = await hub.call('test', 'click', { target: { role: 'button', name: 'Go' } });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /attach/i);
  assert.equal(extension.seen.length, 0);
  // Observation, discovery and a panel note reach the extension without a lease.
  assert.equal((await hub.call('test', 'snapshot', {})).ok, true);
  assert.equal((await hub.call('test', 'tabs', { action: 'list' })).ok, true);
  assert.equal((await hub.call('test', 'say', { text: 'looking' })).ok, true);
  // Closing a tab is not discovery.
  const closed = await hub.call('test', 'tabs', { action: 'close', tabId: 3 });
  assert.equal(closed.ok, false);
  assert.match(closed.text, /attach/i);
  // A lease bound to no tab owns nothing; binding it is what authorizes the action.
  hub.acquireLease('test', {});
  assert.equal((await hub.call('test', 'click', { target: { role: 'button', name: 'Go' } })).ok, false);
  hub.bindLease('test', 7);
  assert.equal((await hub.call('test', 'click', { target: { role: 'button', name: 'Go' } })).ok, true);
  await extension.stop();
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
  hub.acquireLease('test', { tabId: 7 });
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
  hub.acquireLease('test', { tabId: 7 });
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

test('the control routes list tabs with their owner and take one for a client', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  const base = `http://127.0.0.1:${hub.port}`;
  const control = (method, path, body) => {
    const query = path.includes('?') ? `&token=test-token` : `?token=test-token`;
    return fetch(`${base}${path}${query}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  hub.acquireLease('session-a', { tabId: 5 });
  const listed = await (await control('GET', '/client/tabs')).json();
  assert.equal(listed.ok, true);
  assert.equal(listed.tabs.length, 3);
  assert.equal(listed.tabs.find(tab => tab.tabId === 5).owner.clientId, 'session-a');
  assert.equal(listed.tabs.find(tab => tab.tabId === 6).owner, null);

  // A tab another client owns is refused, and the refusal names the owner.
  const taken = await control('POST', '/client/tab', { clientId: 'session-b', tabId: 5 });
  assert.equal(taken.status, 409);
  assert.match((await taken.json()).error, /session-a/);
  assert.equal(hub.ownedTabId('session-b'), null);

  const own = await (await control('POST', '/client/tab', { clientId: 'session-b', tabId: 6 })).json();
  assert.equal(own.ok, true);
  assert.equal(own.lease.tabId, 6);
  assert.equal(hub.ownedTabId('session-b'), 6);
  // Attaching is what lets the client act, so the action goes through afterwards.
  assert.equal((await hub.call('session-b', 'click', { target: { role: 'button', name: 'Go' } })).ok, true);

  // Attaching another free tab adds it: a task owns a set, and the first tab is still its own.
  const moved = await (await control('POST', '/client/tab', { clientId: 'session-b', tabId: 7 })).json();
  assert.equal(moved.ok, true);
  assert.deepEqual(hub.tabsOf('session-b'), [6, 7]);
  assert.equal(hub.ownerOf(6).clientId, 'session-b');

  assert.equal((await control('POST', '/client/tab', { clientId: 'session-b' })).status, 400);
  assert.equal((await control('POST', '/client/tab', { tabId: 6 })).status, 400);
  assert.equal((await (await control('DELETE', '/client/lease?clientId=session-b')).json()).released, true);
  assert.equal(hub.ownedTabId('session-b'), null);
  await extension.stop();
});

test('a failed attach leaves no lease behind', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub, { attachFails: true });
  await waitFor(() => hub.connected);
  const response = await fetch(`http://127.0.0.1:${hub.port}/client/tab?token=test-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'session-c', tabId: 6 }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /cannot be driven/);
  // The empty lease the route took is gone again, so the client holds nothing and can act on nothing.
  assert.equal(hub.leaseOf('session-c'), undefined);
  assert.equal((await hub.call('session-c', 'click', { target: { role: 'button', name: 'Go' } })).ok, false);
  await extension.stop();
});

test('the hub remembers the tab each result reports and the last failure text', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub, { fail: ['click'] });
  await waitFor(() => hub.connected);
  hub.acquireLease('test', { tabId: 5 });

  const failed = await hub.call('test', 'click', { target: { role: 'button', name: 'Go' } });
  assert.equal(failed.ok, false);
  const tab = hub.lastTabOf('test');
  assert.equal(tab.tabId, 5);
  assert.equal(tab.url, 'https://example.test/a');
  assert.equal(tab.title, 'A');
  // The prompt gets the layer's words, not a summary of them.
  assert.match(hub.lastFailureOf('test').text, /error NO_MATCH \(nothing dispatched; safe to retry\)/);
  assert.match(hub.lastFailureOf('test').text, /Take a snapshot to see what the page contains\./);

  // A call that works clears the failure, and another client sees neither.
  assert.equal((await hub.call('test', 'snapshot', {})).ok, true);
  assert.equal(hub.lastFailureOf('test'), undefined);
  assert.equal(hub.lastTabOf('other'), undefined);
  assert.equal(hub.lastFailureOf('other'), undefined);
  await extension.stop();
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
  hub.acquireLease('test', { tabId: 7 });
  await hub.call('test', 'click', { target: { role: 'button', name: 'Go' } });
  const rows = hub.audit('test', 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'click');
  assert.equal(rows[0].clientId, 'test');
  assert.equal(rows[0].ok, true);
  assert.deepEqual(rows[0].args, { target: '{…}' });
  // The tab the extension reported with the result: an audit can be read per page, not only per session.
  assert.equal(rows[0].tabId, 5);
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

test('detaching gives the tab back to the extension before the lease', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  hub.acquireLease('session-a', { tabId: 5 });

  assert.equal(await hub.releaseTab('session-a'), true);
  const unshared = extension.seen.find(command => command.tool === 'unshare');
  assert.equal(unshared?.args?.tabId, 5);
  assert.equal(hub.leaseOf('session-a'), undefined);
  // Nothing to give back the second time is not an error.
  assert.equal(await hub.releaseTab('session-a'), false);
  await extension.stop();
});

test('the lease route unshares as well as releases', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  hub.acquireLease('session-a', { tabId: 5 });

  const response = await fetch(`http://127.0.0.1:${hub.port}/client/lease?clientId=session-a&token=test-token`, {
    method: 'DELETE',
  });
  assert.equal((await response.json()).released, true);
  assert.ok(extension.seen.some(command => command.tool === 'unshare' && command.args.tabId === 5));
  await extension.stop();
});

test('a client owns a set of tabs, and giving one back keeps the rest', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  assert.equal((await hub.ownTab('session-a', 6)).ok, true);
  assert.equal((await hub.ownTab('session-a', 7)).ok, true);
  assert.deepEqual(hub.tabsOf('session-a'), [6, 7]);
  // Another client still cannot take either of them.
  const refused = await hub.ownTab('session-b', 7);
  assert.equal(refused.reason ?? (refused.ok ? undefined : 'tab-leased'), 'tab-leased');

  assert.equal(await hub.releaseOneTab('session-a', 6), true);
  assert.deepEqual(hub.tabsOf('session-a'), [7]);
  assert.ok(extension.seen.some(command => command.tool === 'unshare' && command.args.tabId === 6));
  // The lease survives while it still has a tab.
  assert.equal(hub.leaseOf('session-a').tabId, 7);
  await extension.stop();
});

test('one tab goes back over the route, and the task keeps the rest', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  assert.equal((await hub.ownTab('session-a', 6)).ok, true);
  assert.equal((await hub.ownTab('session-a', 7)).ok, true);
  const release = body =>
    fetch(`http://127.0.0.1:${hub.port}/client/tab/release?token=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const released = await release({ clientId: 'session-a', tabId: 6 });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).ok, true);
  assert.deepEqual(hub.tabsOf('session-a'), [7]);
  assert.ok(extension.seen.some(command => command.tool === 'unshare' && command.args.tabId === 6));

  // A tab the task does not hold is a miss, not a silent success.
  const missing = await release({ clientId: 'session-a', tabId: 6 });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).ok, false);
  await extension.stop();
});

test('a panel hears the session list again when a lease changes', async t => {
  const hub = await startHub(t);
  const sessions = () => [{ id: 'session-a', title: 'Task A', status: 'idle', tabs: hub.tabsOf('session-a') }];
  hub.setChatService({
    async hello() {
      return {
        sessions: sessions(),
        sessionId: 'session-a',
        history: { sessionId: 'session-a', live: true, messages: [] },
      };
    },
    async sessions() {
      return sessions();
    },
    async history(sessionId) {
      return { sessionId, live: true, messages: [] };
    },
    async send(input) {
      return { sessionId: input.sessionId, messageId: 'm1', mode: 'followup' };
    },
    async stop() {
      return { sessionId: 'session-a' };
    },
  });
  const received = [];
  const ws = new WebSocket(`ws://127.0.0.1:${hub.port}/client/chat/ws?token=test-token&sessionId=session-a`);
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket test timed out')), 3000);
    ws.onerror = error => {
      clearTimeout(timer);
      reject(error);
    };
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      received.push(message);
      if (message.type === 'hello') {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  await opened;
  // A tab joins the task: the panel is told without asking, so its chips and the task's group follow.
  hub.acquireLease('session-a', { tabId: 6 });
  await waitFor(() => received.some(message => message.type === 'sessions' && message.sessions[0]?.tabs?.length));
  const pushed = received.filter(message => message.type === 'sessions').at(-1);
  assert.deepEqual(pushed.sessions[0].tabs, [6]);
  assert.equal(pushed.sessions[0].title, 'Task A');
  ws.close();
});

test('the audit route shows this client its own calls, and only its own', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  hub.acquireLease('session-a', { tabId: 5 });
  await hub.call('session-a', 'snapshot', {});
  hub.acquireLease('session-b', { tabId: 6 });
  await hub.call('session-b', 'click', { target: { role: 'button', name: 'Go' } });

  const own = await fetch(`http://127.0.0.1:${hub.port}/client/audit?clientId=session-a&limit=5&token=test-token`).then(
    response => response.json(),
  );
  assert.equal(own.ok, true);
  assert.deepEqual(
    own.calls.map(call => call.tool),
    ['snapshot'],
  );
  assert.equal(typeof own.status.connected, 'boolean');

  const all = await fetch(`http://127.0.0.1:${hub.port}/client/audit?limit=5&token=test-token`).then(response =>
    response.json(),
  );
  assert.equal(all.calls.length, 2);
  await extension.stop();
});

test('a tab event joins the lease, and a closed tab leaves it', async t => {
  const hub = await startHub(t);
  const extension = fakeExtension(hub);
  await waitFor(() => hub.connected);
  hub.acquireLease('session-a', { tabId: 5 });
  const event = body =>
    fetch(`http://127.0.0.1:${hub.port}/event?token=test-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // A page opened tab 9 and the session adopted it: the lease follows without a command.
  await event({ type: 'tab', clientId: 'session-a', tabId: 9 });
  assert.deepEqual(hub.tabsOf('session-a'), [5, 9]);

  // A closed tab cannot be acted on, so it leaves the lease; the lease itself stays while it has tabs.
  await event({ type: 'tab-closed', clientId: 'session-a', tabId: 5 });
  assert.deepEqual(hub.tabsOf('session-a'), [9]);
  await event({ type: 'tab-closed', clientId: 'session-a', tabId: 9 });
  assert.equal(hub.leaseOf('session-a'), undefined);
  await extension.stop();
});
