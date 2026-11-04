// Recording a skill: only what succeeded becomes a step, a fixed wait becomes a condition when it can, and the notes
// say what was left out. The transcript is the source of truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureTurn } from '../core/capture.js';

const call = (turn, name, args, callId) => ({
  type: 'tool/call',
  data: { turn, name, arguments: JSON.stringify(args), callId },
});
const result = (turn, callId, text) => ({
  type: 'tool/result',
  data: { turn, message: { toolCallId: callId, content: [{ type: 'text', text }] } },
});
const session = (...events) => ({ snapshotEvents: () => events });

test('a fixed wait before a targeted step becomes a condition on that target', () => {
  const captured = captureTurn(
    session(
      call(1, 'nanobrowser_navigate', { url: 'https://example.test/q' }, 'c1'),
      result(1, 'c1', 'navigate ok'),
      call(1, 'nanobrowser_wait', { ms: 1500 }, 'c2'),
      result(1, 'c2', 'waited 1500 ms'),
      call(1, 'nanobrowser_click', { target: { role: 'button', name: '查询' } }, 'c3'),
      result(1, 'c3', 'clicked'),
    ),
  );

  assert.deepEqual(
    captured.steps.map(step => [step.id, step.tool, step.args]),
    [
      ['s1', 'navigate', { url: 'https://example.test/q' }],
      ['s2', 'wait', { state: 'visible' }],
      ['s3', 'click', {}],
    ],
  );
  // The wait now waits for the thing the run was about to act on, not for a guess at how long the page needs.
  assert.deepEqual(captured.steps[1].target, { role: 'button', name: '查询' });
  assert.deepEqual(captured.steps[2].target, { role: 'button', name: '查询' });
});

test('a fixed wait nothing follows stays, and is called out', () => {
  const captured = captureTurn(
    session(
      call(1, 'nanobrowser_click', { target: { role: 'button', name: '提交' } }, 'c1'),
      result(1, 'c1', 'clicked'),
      call(1, 'nanobrowser_wait', { ms: 3000 }, 'c2'),
      result(1, 'c2', 'waited 3000 ms'),
    ),
  );
  assert.deepEqual(captured.steps[1].args, { ms: 3000 });
  assert.match(captured.notes.join(' '), /Step s2 waits a fixed 3000 ms/);
});

test('a wait for text is not turned into a target wait', () => {
  const captured = captureTurn(
    session(
      call(1, 'nanobrowser_wait', { text: '结果', ms: 2000 }, 'c1'),
      result(1, 'c1', 'waited'),
      call(1, 'nanobrowser_click', { target: { role: 'button', name: '详情' } }, 'c2'),
      result(1, 'c2', 'clicked'),
    ),
  );
  assert.deepEqual(captured.steps[0].args, { text: '结果', ms: 2000 });
  assert.equal(captured.steps[0].target, undefined);
});

test('only successful calls become steps, and a parameter replaces the literal', () => {
  const captured = captureTurn(
    session(
      call(1, 'nanobrowser_click', { target: { role: 'button', name: '查询' } }, 'c1'),
      result(1, 'c1', 'clicked'),
      call(1, 'nanobrowser_set', { target: { role: 'textbox', name: '订单号' }, value: 'ORD-1001' }, 'c2'),
      result(1, 'c2', 'set ok'),
      call(1, 'nanobrowser_type', { text: 'ORD-1001' }, 'c3'),
      result(1, 'c3', 'error NO_MATCH (nothing dispatched; safe to retry)\nNo element matches.'),
    ),
    { params: { orderNo: 'ORD-1001' } },
  );

  assert.deepEqual(
    captured.steps.map(step => step.tool),
    ['click', 'set'],
  );
  assert.equal(captured.steps[1].args.value, '{{orderNo}}');
  assert.deepEqual(captured.params, { orderNo: { type: 'string', required: true } });
  assert.match(captured.notes.join(' '), /Skipped type/);
});

test('a ref never reaches a recipe, and a step without a name is dropped', () => {
  const captured = captureTurn(
    session(
      call(1, 'nanobrowser_click', { target: { role: 'button', name: '查询' } }, 'c1'),
      result(1, 'c1', 'clicked'),
      call(1, 'nanobrowser_click', { target: { ref: 'e42' } }, 'c2'),
      result(1, 'c2', 'clicked'),
    ),
  );
  assert.deepEqual(
    captured.steps.map(step => step.tool),
    ['click'],
  );
  assert.deepEqual(captured.steps[0].target, { role: 'button', name: '查询' });
  assert.match(captured.notes.join(' '), /Skipped click/);
});

test('a field name in words becomes the parameter name', () => {
  const captured = captureTurn(
    session(
      call(1, 'nanobrowser_set', { target: { role: 'textbox', name: 'Order number' }, value: 'ORD-1001' }, 'c1'),
      result(1, 'c1', 'set ok'),
    ),
  );
  assert.deepEqual(captured.steps[0].args, { value: '{{orderNumber}}' });
  assert.deepEqual(captured.params, { orderNumber: { type: 'string', required: true } });
  assert.match(captured.notes.join(' '), /Inferred params from the fields: orderNumber\./);
});

test('a label in another script is not turned into a parameter', () => {
  const captured = captureTurn(
    session(
      call(1, 'nanobrowser_set', { target: { role: 'textbox', name: '订单号' }, value: 'ORD-1001' }, 'c1'),
      result(1, 'c1', 'set ok'),
    ),
  );
  assert.deepEqual(captured.steps[0].args, { value: 'ORD-1001' });
  assert.deepEqual(captured.params, {});
});

test('a run longer than the step limit is refused instead of truncated', () => {
  const calls = [];
  for (let index = 0; index < 3; index += 1) {
    calls.push(call(1, 'nanobrowser_click', { target: { role: 'button', name: `b${index}` } }, `c${index}`));
    calls.push(result(1, `c${index}`, 'clicked'));
  }
  assert.throws(() => captureTurn(session(...calls), { maxSteps: 2 }), /3 actions and the limit is 2/);
});
