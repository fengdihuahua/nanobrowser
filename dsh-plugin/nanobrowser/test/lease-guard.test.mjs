// The lease guard: a browser action without a tab lease is refused; discovery and panel notes stay available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLeaseGuard, requiresLease } from '../host/lease-guard.js';
import { runSkill } from '../core/run.js';

test('only page tools require a lease', () => {
  assert.equal(requiresLease('nanobrowser_click'), true);
  assert.equal(requiresLease('nanobrowser_snapshot'), true);
  assert.equal(requiresLease('nanobrowser_navigate'), true);
  assert.equal(requiresLease('nanobrowser_attach'), false);
  assert.equal(requiresLease('nanobrowser_status'), false);
  assert.equal(requiresLease('nanobrowser_audit'), false);
  assert.equal(requiresLease('nanobrowser_tabs', { action: 'list' }), false);
  assert.equal(requiresLease('nanobrowser_tabs', { action: 'open' }), true);
  assert.equal(requiresLease('nanobrowser_tabs', { action: 'select' }), true);
  assert.equal(requiresLease('browser_skill_run'), false);
});

test('the guard refuses a page tool without a lease and allows one with it', () => {
  let guard;
  const ctx = {
    tools: {
      guard(listener) {
        guard = listener;
        return () => {};
      },
    },
  };
  const hub = { leaseOf: id => (id === 's1' ? { clientId: 's1', tabId: 7 } : undefined) };
  registerLeaseGuard(ctx, hub);
  assert.match(guard({ name: 'nanobrowser_click', agent: { id: 's2' } }), /attach/i);
  assert.equal(guard({ name: 'nanobrowser_click', agent: { id: 's1' } }), undefined);
  assert.equal(guard({ name: 'nanobrowser_attach', agent: { id: 's2' } }), undefined);
  assert.equal(guard({ name: 'nanobrowser_audit', agent: { id: 's2' } }), undefined);
  assert.equal(guard({ name: 'nanobrowser_tabs', arguments: { action: 'list' }, agent: { id: 's2' } }), undefined);
  assert.match(guard({ name: 'nanobrowser_tabs', arguments: { action: 'open' }, agent: { id: 's2' } }), /attach/i);
  assert.equal(guard({ name: 'browser_skill_run', agent: { id: 's2' } }), undefined);
});

test('a skill refuses to run without a lease', async () => {
  const result = await runSkill(
    { leaseOf: () => undefined },
    's1',
    { maxSteps: 10, stepDelayMs: 0 },
    {
      name: 'no-lease',
      recipe: {
        name: 'no-lease',
        params: {},
        steps: [{ id: 's1', tool: 'navigate', args: { url: 'https://example.test/' } }],
        assert: [],
      },
    },
    {},
  );
  assert.equal(result.ok, false);
  assert.match(result.text, /attach/i);
});
