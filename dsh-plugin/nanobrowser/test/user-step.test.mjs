// `nanobrowser_wait_for_user`: the tool publishes a step to the drawer, waits for Continue, and refuses without a drawer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerUserSteps } from '../host/user-step.js';

function setup({ clients = 1 } = {}) {
  const hub = {
    events: [],
    service: null,
    clients,
    hasWsClients() {
      return this.clients > 0;
    },
    publish(event) {
      this.events.push(event);
    },
    setUserStepService(service) {
      this.service = service;
    },
  };
  let tool;
  const ctx = {
    tools: {
      register(definition) {
        tool = definition;
        return () => {};
      },
    },
  };
  const cleanup = registerUserSteps(ctx, hub, { userStepTimeoutMs: 120_000 });
  return { ctx, hub, tool, cleanup };
}

test('the tool publishes the step and returns when the drawer continues', async t => {
  const { hub, tool, cleanup } = setup();
  t.after(cleanup);
  assert.equal(tool.name, 'nanobrowser_wait_for_user');
  const promise = tool.execute({ text: 'Log in, then continue' }, { agent: { id: 's1' } });
  const event = hub.events.find(item => item.type === 'user-step');
  assert.equal(event.sessionId, 's1');
  assert.equal(event.text, 'Log in, then continue');
  assert.equal(event.timeoutMs, 120_000);
  assert.equal(hub.service.answer(event.id), true);
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, 'The user continued.');
});

test('a second answer for the same step is ignored', async t => {
  const { hub, tool, cleanup } = setup();
  t.after(cleanup);
  const promise = tool.execute({ text: 'Continue' }, { agent: { id: 's1' } });
  const event = hub.events.find(item => item.type === 'user-step');
  assert.equal(hub.service.answer(event.id), true);
  assert.equal(hub.service.answer(event.id), false);
  await promise;
});

test('without a connected drawer the tool refuses instead of blocking', async t => {
  const { tool, cleanup } = setup({ clients: 0 });
  t.after(cleanup);
  await assert.rejects(() => tool.execute({ text: 'Continue' }, { agent: { id: 's1' } }), /drawer/i);
});

test('an empty instruction is refused', async t => {
  const { tool, cleanup } = setup();
  t.after(cleanup);
  await assert.rejects(() => tool.execute({ text: '   ' }, { agent: { id: 's1' } }), /instruction/i);
});
