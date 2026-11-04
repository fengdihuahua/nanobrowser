// The chat service's contract without DSH or Chrome: session list, history, followup/steer, page context, stop and
// event publication. Sending a real message from a test would wake a live Agent, so the Agent is a fake here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerChat, buildPageContext } from '../host/chat.js';

function fakeAgent() {
  const follows = [];
  const steers = [];
  const cancels = [];
  const agent = {
    id: 's1',
    status: 'idle',
    session: {
      header: { createdAt: 2 },
      deriveMessages: () => [{ role: 'user', id: 'u1', content: [{ type: 'text', text: 'hello' }] }],
    },
    followup: message => follows.push(message),
    steer: message => steers.push(message),
    cancel: cause => cancels.push(cause),
  };
  return { agent, follows, steers, cancels };
}

function fakeHub() {
  const calls = [];
  const events = [];
  return {
    chat: null,
    calls,
    events,
    setChatService(service) {
      this.chat = service;
    },
    publish(event) {
      events.push(event);
    },
    async call(clientId, tool, args) {
      calls.push({ clientId, tool, args });
      if (tool === 'tabs') {
        return { ok: true, text: 'tabs · 1 in session\n* tab 7 · «Fixture» · «http://127.0.0.1:8787/d-fill.html»' };
      }
      if (tool === 'read') return { ok: true, text: 'page text' };
      return { ok: true, text: '' };
    },
  };
}

function setup() {
  const { agent, follows, steers, cancels } = fakeAgent();
  const hub = fakeHub();
  const ctx = {
    agents: { roots: () => [agent], get: id => (id === 's1' ? agent : undefined) },
    on: () => () => {},
  };
  const cleanup = registerChat(ctx, hub, { pageContextChars: 1000 });
  return { agent, hub, follows, steers, cancels, cleanup };
}

test('sessions and history come from the live Agent', async t => {
  const { hub, cleanup } = setup();
  t.after(cleanup);
  const sessions = await hub.chat.sessions();
  assert.deepEqual(sessions, [{ id: 's1', title: 'hello', status: 'idle', running: false, createdAt: 2, tabs: [] }]);
  const history = await hub.chat.history('s1');
  assert.equal(history.live, true);
  assert.deepEqual(history.messages, [{ kind: 'user', id: 'u1', text: 'hello' }]);
});

test('idle sends a followup, running sends a steer, both as user messages', async t => {
  const { agent, hub, follows, steers, cleanup } = setup();
  t.after(cleanup);
  const first = await hub.chat.send({ sessionId: 's1', text: 'hi' });
  assert.equal(first.mode, 'followup');
  assert.equal(follows.length, 1);
  assert.equal(follows[0].role, 'user');
  assert.deepEqual(follows[0].source, { kind: 'user' });
  assert.equal(follows[0].content[0].text, 'hi');

  agent.status = 'running';
  const second = await hub.chat.send({ sessionId: 's1', text: 'wait' });
  assert.equal(second.mode, 'steer');
  assert.equal(steers.length, 1);
  assert.equal(steers[0].content[0].text, 'wait');
});

test('a message can carry the active page as bounded context', async t => {
  const { hub, follows, cleanup } = setup();
  t.after(cleanup);
  const result = await hub.chat.send({ sessionId: 's1', text: 'explain this', includePage: true });
  assert.equal(result.pageContext, true);
  assert.equal(follows.length, 1);
  const text = follows[0].content[0].text;
  assert.match(text, /^<page_context url="http:\/\/127\.0\.0\.1:8787\/d-fill\.html" title="Fixture">/);
  assert.match(text, /page text/);
  assert.match(text, /explain this$/);
  assert.deepEqual(
    hub.calls.map(call => call.tool),
    ['tabs', 'read'],
  );
});

test('stop cancels the session as the user', async t => {
  const { hub, cancels, cleanup } = setup();
  t.after(cleanup);
  hub.chat.stop({ sessionId: 's1' });
  assert.deepEqual(cancels, [{ kind: 'user' }]);
});

test('a committed tool call is published for the panel', async t => {
  const { hub, cleanup } = setup();
  t.after(cleanup);
  hub.chat.handleEvent(
    { id: 's1' },
    { type: 'tool/call', data: { callId: 'c1', name: 'click', arguments: '{"target":{"ref":"e1"}}' } },
  );
  assert.equal(hub.events.length, 1);
  assert.equal(hub.events[0].type, 'chat');
  assert.equal(hub.events[0].sessionId, 's1');
  assert.deepEqual(hub.events[0].event, {
    kind: 'tool-call',
    callId: 'c1',
    name: 'click',
    args: '{"target":{"ref":"e1"}}',
  });
});

// ---- the page context a message carries -------------------------------------------------------------------------

function pageHub(read) {
  return {
    async call(_clientId, tool) {
      if (tool === 'tabs') {
        return { ok: true, text: 'tabs · 1 in session\n* tab 7 · «Fixture» · «http://127.0.0.1:8787/d-fill.html»' };
      }
      if (tool === 'read') return read;
      return { ok: true, text: '' };
    },
  };
}

test('a page context carries the user selection inside the boundary', async () => {
  const context = await buildPageContext(
    pageHub({ ok: true, text: 'page text', data: { selection: { text: 'Fill a form' } } }),
    { pageContextChars: 1000 },
    's1',
  );
  assert.match(context, /^<page_context url="http:\/\/127\.0\.0\.1:8787\/d-fill\.html" title="Fixture">/);
  assert.match(context, /<selection>Fill a form<\/selection>/);
  assert.match(context, /page text/);
});

test('without a selection the page context has no selection element', async () => {
  const context = await buildPageContext(pageHub({ ok: true, text: 'page text' }), { pageContextChars: 1000 }, 's1');
  assert.doesNotMatch(context, /<selection>/);
});

test('a selection that looks like markup stays text inside the boundary', async () => {
  const context = await buildPageContext(
    pageHub({ ok: true, text: 'x', data: { selection: { text: '<b>bold</b>' } } }),
    { pageContextChars: 1000 },
    's1',
  );
  assert.match(context, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(context, /<b>/);
});

test('a page that cannot be read gives no context instead of a broken one', async () => {
  const context = await buildPageContext(pageHub({ ok: false, text: 'no tab' }), { pageContextChars: 1000 }, 's1');
  assert.equal(context, '');
});

test('the panel opens on the session that owns the tab it was opened on', async t => {
  const { agent } = fakeAgent();
  const second = { ...agent, id: 's2', session: { header: { createdAt: 3 }, deriveMessages: () => [] } };
  const hub = fakeHub();
  hub.tabsOf = id => (id === 's1' ? [7] : id === 's2' ? [9] : []);
  const ctx = {
    agents: { roots: () => [agent, second], get: id => (id === 's1' ? agent : id === 's2' ? second : undefined) },
    on: () => () => {},
  };
  const cleanup = registerChat(ctx, hub, { pageContextChars: 1000 });
  t.after(cleanup);

  // s2 is the newer session, but the panel was opened on tab 9, which s2 owns.
  assert.equal((await hub.chat.hello(null, 9)).sessionId, 's2');
  assert.equal((await hub.chat.hello(null, 7)).sessionId, 's1');
  // A tab nobody owns falls back to the newest session, and an explicit session still wins.
  assert.equal((await hub.chat.hello(null, 3)).sessionId, 's2');
  assert.equal((await hub.chat.hello('s1', 9)).sessionId, 's1');
  assert.deepEqual((await hub.chat.sessions()).find(s => s.id === 's2').tabs, [9]);
});
