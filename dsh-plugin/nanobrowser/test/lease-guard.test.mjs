// The lease guard: a browser action without a tab lease is refused; discovery and panel notes stay available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerLeaseGuard, requiresLease } from '../host/lease-guard.js';
import { runSkill } from '../core/run.js';

test('only the tools that act on a tab require a lease', () => {
  // Actions, and the tab commands that move or close a tab, need an owner.
  assert.equal(requiresLease('nanobrowser_click'), true);
  assert.equal(requiresLease('nanobrowser_navigate'), true);
  assert.equal(requiresLease('nanobrowser_wait'), true);
  assert.equal(requiresLease('nanobrowser_tabs', { action: 'select' }), true);
  assert.equal(requiresLease('nanobrowser_tabs', { action: 'close' }), true);
  // Observation, discovery and panel notes do not, so a message can carry the page it came from.
  assert.equal(requiresLease('nanobrowser_snapshot'), false);
  assert.equal(requiresLease('nanobrowser_read'), false);
  assert.equal(requiresLease('nanobrowser_console'), false);
  assert.equal(requiresLease('nanobrowser_attach'), false);
  assert.equal(requiresLease('nanobrowser_status'), false);
  assert.equal(requiresLease('nanobrowser_audit'), false);
  assert.equal(requiresLease('nanobrowser_tabs', { action: 'list' }), false);
  assert.equal(requiresLease('nanobrowser_tabs', { action: 'open' }), false);
  assert.equal(requiresLease('browser_skill_run'), false);
});

test('the guard refuses an action without a tab and allows one with it', () => {
  let guard;
  const ctx = {
    tools: {
      guard(listener) {
        guard = listener;
        return () => {};
      },
    },
  };
  const hub = { ownedTabId: id => (id === 's1' ? 7 : null) };
  registerLeaseGuard(ctx, hub);
  assert.match(guard({ name: 'nanobrowser_click', agent: { id: 's2' } }), /attach/i);
  assert.equal(guard({ name: 'nanobrowser_click', agent: { id: 's1' } }), undefined);
  // A lease bound to no tab owns nothing, so it authorizes nothing.
  assert.match(guard({ name: 'nanobrowser_click', agent: { id: 's3' } }), /attach/i);
  assert.equal(guard({ name: 'nanobrowser_snapshot', agent: { id: 's2' } }), undefined);
  assert.equal(guard({ name: 'nanobrowser_attach', agent: { id: 's2' } }), undefined);
  assert.equal(guard({ name: 'nanobrowser_audit', agent: { id: 's2' } }), undefined);
  assert.equal(guard({ name: 'nanobrowser_tabs', arguments: { action: 'list' }, agent: { id: 's2' } }), undefined);
  assert.equal(guard({ name: 'nanobrowser_tabs', arguments: { action: 'open' }, agent: { id: 's2' } }), undefined);
  assert.match(guard({ name: 'nanobrowser_tabs', arguments: { action: 'close' }, agent: { id: 's2' } }), /attach/i);
  assert.equal(guard({ name: 'browser_skill_run', agent: { id: 's2' } }), undefined);
});

test('a skill refuses to run without a lease', async () => {
  const result = await runSkill(
    { ownedTabId: () => null, call: async () => ({ ok: false, text: 'the extension is not connected' }) },
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
