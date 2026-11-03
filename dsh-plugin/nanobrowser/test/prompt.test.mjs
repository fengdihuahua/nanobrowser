// The live browser facts DSH adds to the prompt before every model step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLiveContext } from '../host/prompt.js';

function fakeHub({ connected = true, lease, rows = [] } = {}) {
  return {
    status: () => ({
      ok: true,
      connected,
      port: 8790,
      lastPollAt: 0,
      clients: [],
      leases: [],
      pendingCalls: 0,
      queued: 0,
    }),
    leaseOf: () => lease,
    audit: () => rows,
  };
}

test('no lease: says so instead of naming a tab', () => {
  const text = browserLiveContext(fakeHub(), 'session-a');
  assert.equal(text, 'Browser now: hub connected · no tab lease.');
});

test('a lease names the tab and the last call reports its outcome and time', () => {
  const text = browserLiveContext(
    fakeHub({
      lease: { clientId: 'session-a', tabId: 42 },
      rows: [{ tool: 'click', ok: true, at: 1, ms: 240 }],
    }),
    'session-a',
  );
  assert.match(text, /tab 42/);
  assert.match(text, /last call click ok in 240 ms/);
  assert.doesNotMatch(text, /stale/);
});

test('a failed call carries a bounded result line', () => {
  const long = 'x'.repeat(400);
  const text = browserLiveContext(fakeHub({ rows: [{ tool: 'set', ok: false, at: 1, text: long }] }), 'session-a');
  assert.match(text, /last call set failed/);
  assert.match(text, /its result: x+…/);
  assert.ok(text.length < 400);
});

test('navigation after the last snapshot makes the older refs stale', () => {
  const text = browserLiveContext(
    fakeHub({
      lease: { clientId: 'session-a', tabId: 7 },
      rows: [
        { tool: 'snapshot', ok: true, at: 1 },
        { tool: 'navigate', ok: true, at: 2 },
      ],
    }),
    'session-a',
  );
  assert.match(text, /navigated after the last snapshot/);
});

test('a snapshot after the navigation clears the stale warning', () => {
  const text = browserLiveContext(
    fakeHub({
      lease: { clientId: 'session-a', tabId: 7 },
      rows: [
        { tool: 'navigate', ok: true, at: 1 },
        { tool: 'snapshot', ok: true, at: 2 },
      ],
    }),
    'session-a',
  );
  assert.doesNotMatch(text, /stale/);
});

test('another session never sees this session calls', () => {
  const hub = fakeHub({ rows: [{ tool: 'click', ok: true, at: 1, ms: 10 }] });
  assert.equal(browserLiveContext(hub, ''), 'Browser now: hub connected · no tab lease.');
});
