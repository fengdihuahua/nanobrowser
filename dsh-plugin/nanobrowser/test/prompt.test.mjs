// The live browser facts DSH adds to the prompt before every model step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserLiveContext } from '../host/prompt.js';

function fakeHub({ connected = true, lease, rows = [], tab, failure, sent, run } = {}) {
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
    lastTabOf: () => tab,
    lastFailureOf: () => failure,
    pageContextOf: () => sent,
    lastRunOf: () => run,
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
  assert.match(text, /tabs 42/);
  assert.match(text, /last call click ok in 240 ms/);
  assert.doesNotMatch(text, /stale/);
});

test('the tab the extension reports is named with its title and url', () => {
  const text = browserLiveContext(
    fakeHub({
      lease: { clientId: 'session-a', tabId: 42 },
      tab: { tabId: 42, url: 'https://example.test/q', title: '订单录入' },
      rows: [{ tool: 'click', ok: true, at: 1, ms: 240 }],
    }),
    'session-a',
  );
  assert.match(text, /on tab 42 «订单录入» — https:\/\/example\.test\/q/);
  assert.doesNotMatch(text, /the lease says/);
});

test('a lease on a different tab than the one driven is called out', () => {
  const text = browserLiveContext(
    fakeHub({
      lease: { clientId: 'session-a', tabId: 42 },
      tab: { tabId: 9, url: 'https://example.test/9', title: 'Nine' },
    }),
    'session-a',
  );
  assert.match(text, /on tab 9/);
  assert.match(text, /the lease names 42 instead/);
});

test('a failed call keeps the layer own words, hint included', () => {
  const long = 'The page changed at the moment of the click. Take a new snapshot; retrying is safe.';
  const text = browserLiveContext(
    fakeHub({
      tab: { tabId: 9, url: 'https://example.test/9', title: 'Nine' },
      rows: [{ tool: 'set', ok: false, at: 1 }],
      failure: { text: `error INTERCEPTED (nothing dispatched; safe to retry)\n${long}`, at: 2 },
    }),
    'session-a',
  );
  assert.match(text, /last call set failed/);
  assert.match(text, /Why the last call failed: error INTERCEPTED/);
  assert.match(text, /retrying is safe\./);
  assert.ok(text.split('\n').length === 2, 'the failure is its own line');
});

test('a long failure line stays bounded', () => {
  const text = browserLiveContext(fakeHub({ failure: { text: 'x'.repeat(2000), at: 2 } }), 'session-a');
  assert.ok(text.length < 800);
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

test('the page a message was sent from is compared with the tab it is on now', () => {
  const drifted = browserLiveContext(
    fakeHub({
      lease: { clientId: 'session-a', tabId: 9 },
      tab: { tabId: 9, url: 'https://example.test/next', title: 'Next' },
      sent: { url: 'https://example.test/start', title: 'Start' },
    }),
    'session-a',
  );
  assert.match(drifted, /the message carried https:\/\/example\.test\/start, and the tab is on a different page since/);

  const same = browserLiveContext(
    fakeHub({
      tab: { tabId: 9, url: 'https://example.test/start', title: 'Start' },
      sent: { url: 'https://example.test/start', title: 'Start' },
    }),
    'session-a',
  );
  assert.doesNotMatch(same, /different page since/);
});

test('where the last skill run stopped is in the live context', () => {
  const text = browserLiveContext(
    fakeHub({
      tab: { tabId: 9, url: 'https://example.test/9', title: 'Nine' },
      run: { name: 'submit-order', outcome: 'failed', failedStep: 'submit', code: 'INTERCEPTED' },
    }),
    'session-a',
  );
  assert.match(text, /last skill run submit-order failed stopped at submit \(INTERCEPTED\)/);
});
