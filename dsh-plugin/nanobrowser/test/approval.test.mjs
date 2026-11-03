// Approval routing without a live Agent: the drawer answers, delegates, times out, or aborts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerApprovals } from '../host/approvals.js';

function setup({ timeoutMs = 50 } = {}) {
  const hub = {
    events: [],
    service: null,
    clients: 1,
    hasWsClients() {
      return this.clients > 0;
    },
    publish(event) {
      this.events.push(event);
    },
    setApprovalService(service) {
      this.service = service;
    },
  };
  const ctx = {
    listener: null,
    on(event, listener) {
      this.listener = listener;
      return () => {
        this.listener = null;
      };
    },
  };
  const cleanup = registerApprovals(ctx, hub, { approvalTimeoutMs: timeoutMs });
  return { ctx, hub, cleanup };
}

function request(signal) {
  return { agent: { id: 's1' }, toolName: 'pwsh', reason: 'test approval', ...(signal ? { signal } : {}) };
}

test('an open drawer receives the request and its allow becomes allowed-once', async t => {
  const { ctx, hub, cleanup } = setup();
  t.after(cleanup);
  let delegated = false;
  const outcome = ctx.listener(request(), async () => {
    delegated = true;
    return 'rejected';
  });
  const event = hub.events.find(item => item.type === 'approval');
  assert.equal(event.sessionId, 's1');
  assert.equal(event.toolName, 'pwsh');
  assert.equal(event.reason, 'test approval');
  assert.equal(hub.service.answer(event.id, 'allow'), true);
  assert.equal(await outcome, 'allowed-once');
  assert.equal(delegated, false);
});

test('deny becomes rejected', async t => {
  const { ctx, hub, cleanup } = setup();
  t.after(cleanup);
  const outcome = ctx.listener(request(), async () => 'allowed-once');
  const event = hub.events.find(item => item.type === 'approval');
  hub.service.answer(event.id, 'deny');
  assert.equal(await outcome, 'rejected');
});

test('without a drawer the request goes to the normal answerer', async t => {
  const { ctx, hub, cleanup } = setup();
  t.after(cleanup);
  hub.clients = 0;
  let delegated = false;
  const outcome = await ctx.listener(request(), async () => {
    delegated = true;
    return 'allowed-once';
  });
  assert.equal(delegated, true);
  assert.equal(outcome, 'allowed-once');
  assert.equal(hub.events.length, 0);
});

test('delegate and timeout both fall back to the normal answerer', async t => {
  const { ctx, hub, cleanup } = setup({ timeoutMs: 20 });
  t.after(cleanup);
  let delegated = 0;
  const next = async () => {
    delegated += 1;
    return 'allowed-once';
  };

  const first = ctx.listener(request(), next);
  hub.service.answer(hub.events.find(item => item.type === 'approval').id, 'delegate');
  assert.equal(await first, 'allowed-once');
  assert.equal(delegated, 1);

  const second = ctx.listener(request(), next);
  assert.equal(await second, 'allowed-once');
  assert.equal(delegated, 2);
});

test('an aborted request is cancelled', async t => {
  const { ctx, cleanup } = setup();
  t.after(cleanup);
  const controller = new AbortController();
  const outcome = ctx.listener(request(controller.signal), async () => 'allowed-once');
  controller.abort();
  assert.equal(await outcome, 'cancelled');
});

test('a second answer for the same id is ignored', async t => {
  const { ctx, hub, cleanup } = setup();
  t.after(cleanup);
  const outcome = ctx.listener(request(), async () => 'allowed-once');
  const event = hub.events.find(item => item.type === 'approval');
  assert.equal(hub.service.answer(event.id, 'allow'), true);
  assert.equal(hub.service.answer(event.id, 'deny'), false);
  assert.equal(await outcome, 'allowed-once');
});
