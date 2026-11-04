// What a skill run reports: a failure that a model can act on (I2), assertions over text, URL, console and network,
// and a warning when a write went unchecked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkill } from '../core/run.js';
import { readKnowledge } from '../core/skills.js';

const TAB = { tabId: 7, title: '订单录入', url: 'https://example.test/orders/1001/edit' };
const INTERCEPTED = {
  code: 'INTERCEPTED',
  message: 'The page changed at the moment of the click and the click was cancelled before it reached the page.',
  hint: 'The page changed at the moment of the click and the click was cancelled before it reached the page. Take a new snapshot; retrying is safe.',
  delivered: false,
};
/** The layer's rendering of that error, longer than the 240 characters a step line used to be cut to. */
const LAYER_TEXT = `error INTERCEPTED (nothing dispatched; safe to retry)\n${INTERCEPTED.message}\n${INTERCEPTED.hint}`;

function fakeHub({ owned = true, answers = {} } = {}) {
  const calls = [];
  return {
    calls,
    ownedTabId: clientId => (owned && clientId === 's1' ? TAB.tabId : null),
    async call(_clientId, tool, args) {
      calls.push({ tool, args });
      if (tool === 'tabs') return { ok: true, text: `* tab ${TAB.tabId} · «${TAB.title}» · «${TAB.url}»` };
      if (tool === 'say') return { ok: true, text: 'shown in the side panel' };
      const answer = answers[tool];
      return typeof answer === 'function' ? answer(args) : (answer ?? { ok: true, text: `${tool} ok` });
    },
  };
}

const recipe = {
  name: 'submit-order',
  params: {},
  origin: 'https://example.test',
  steps: [
    { id: 'find', tool: 'click', target: { role: 'button', name: '查询' } },
    { id: 'submit', tool: 'click', target: { role: 'button', name: '提交' } },
  ],
  assert: [],
};

const settings = { maxSteps: 20, stepDelayMs: 0 };

test('a failed step returns the layer code, the delivery, the hint in full and the current URL', async () => {
  const hub = fakeHub({
    answers: {
      click: args =>
        args.target.name === '提交'
          ? { ok: false, text: LAYER_TEXT, error: INTERCEPTED }
          : { ok: true, text: 'clicked' },
    },
  });
  const result = await runSkill(hub, 's1', settings, { name: recipe.name, recipe }, { quiet: true });

  assert.equal(result.ok, false);
  const failure = result.data.failure;
  assert.equal(failure.code, 'INTERCEPTED');
  assert.equal(failure.stepId, 'submit');
  assert.equal(failure.tool, 'click');
  assert.equal(failure.delivered, false);
  assert.equal(failure.hint, INTERCEPTED.hint);
  assert.equal(failure.url, TAB.url);
  assert.equal(failure.title, TAB.title);
  assert.equal(failure.tabId, TAB.tabId);

  // The text the model reads keeps the failed step's own words, right to the end of the hint, and says where it is.
  assert.match(result.text, /failed at step submit/);
  assert.ok(result.text.includes('retrying is safe.'), 'the end of the hint was cut off');
  assert.match(result.text, /^ {3}error INTERCEPTED/m);
  assert.ok(result.text.includes(`Where: tab ${TAB.tabId} «${TAB.title}» — ${TAB.url}`));
  // The step that passed is still reported, and the failed one is named on its line.
  assert.match(result.text, /✓ find · clicked/);
  assert.match(result.text, /✗ submit · click/);
  // Nothing was attempted after the failure.
  assert.equal(hub.calls.filter(call => call.tool === 'click').length, 2);
});

test('a failed assertion says which check failed, and that a write may have landed', async () => {
  const hub = fakeHub({
    answers: {
      wait: () => ({
        ok: false,
        text: 'error TIMEOUT (nothing dispatched; safe to retry)\nThe operation did not finish in time.\nThe operation did not finish in time.',
      }),
    },
  });
  const withCheck = {
    ...recipe,
    steps: [recipe.steps[0]],
    assert: [{ after: 'find', text: '提交成功' }],
  };
  const result = await runSkill(hub, 's1', settings, { name: withCheck.name, recipe: withCheck }, { quiet: true });

  assert.equal(result.ok, false);
  assert.equal(result.data.failure.code, 'ASSERT_TEXT');
  assert.equal(result.data.failure.stepId, 'find');
  assert.equal(result.data.failure.delivered, 'unknown');
  assert.match(result.data.failure.message, /提交成功/);
  assert.ok(result.text.includes('提交成功'));
  // The layer's own words about the wait come along, and the step itself still shows as done.
  assert.ok(result.text.includes('The operation did not finish in time.'));
  // The step itself ran; the check is what failed.
  assert.match(result.text, /✓ find · click ok/);
});

test('a run with no tab fails with a code and the way out, without touching the page', async () => {
  const hub = fakeHub({ owned: false });
  const result = await runSkill(hub, 's1', settings, { name: recipe.name, recipe }, { quiet: true });

  assert.equal(result.ok, false);
  assert.equal(result.data.failure.code, 'NO_LEASE');
  assert.equal(result.data.failure.delivered, false);
  assert.match(result.text, /attach/i);
  assert.equal(hub.calls.filter(call => call.tool === 'click').length, 0);
});

test('a run that works has no failure block', async () => {
  const hub = fakeHub();
  const result = await runSkill(hub, 's1', settings, { name: recipe.name, recipe }, { quiet: true });
  assert.equal(result.ok, true);
  assert.equal(result.data.failure, undefined);
  assert.match(result.text, /^Ran skill "submit-order" · 2 steps/);
});

test('a write nothing checks is called out, and one that is checked is not', async () => {
  const receipt = {
    action: 'click',
    mechanism: 'cdp',
    dispatched: true,
    effect: { verdict: 'changed', signals: [] },
    sensitive: 'submit',
  };
  const hub = fakeHub({ answers: { click: () => ({ ok: true, text: 'clicked', receipt }) } });
  const step = { id: 'send', tool: 'click', target: { role: 'button', name: '提交' } };

  const unchecked = await runSkill(
    hub,
    's1',
    settings,
    { name: 'w', recipe: { ...recipe, steps: [step], assert: [] } },
    { quiet: true },
  );
  assert.equal(unchecked.ok, true);
  assert.deepEqual(unchecked.data.unchecked, ['send']);
  assert.match(unchecked.text, /⚠ Nothing checks send \(submit\)/);
  assert.match(unchecked.text, /a silent failure would look like success/);

  const checked = await runSkill(
    hub,
    's1',
    settings,
    { name: 'w', recipe: { ...recipe, steps: [step], assert: [{ after: 'send', text: '提交成功' }] } },
    { quiet: true },
  );
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.data.unchecked, []);
  assert.doesNotMatch(checked.text, /⚠/);
});

test('console errors can be asserted, and the failing lines are shown', async () => {
  const hub = fakeHub({
    answers: { console: { ok: true, text: '', data: { entries: [{ level: 'error', text: 'boom' }] } } },
  });
  const bad = await runSkill(
    hub,
    's1',
    settings,
    { name: 'x', recipe: { ...recipe, steps: [recipe.steps[0]], assert: [{ after: 'find', consoleErrors: 0 }] } },
    { quiet: true },
  );
  assert.equal(bad.data.failure.code, 'ASSERT_CONSOLE');
  assert.match(bad.text, /1 error; at most 0 allowed/);
  assert.match(bad.text, /\[error\] boom/);

  // No console answer means no errors: the check passes.
  const clean = await runSkill(
    hub,
    's1',
    settings,
    { name: 'x', recipe: { ...recipe, steps: [recipe.steps[0]], assert: [{ after: 'find', consoleErrors: 2 }] } },
    { quiet: true },
  );
  assert.equal(clean.ok, true);
});

test('a network request can be asserted on by url and status', async () => {
  const entries = [{ url: 'https://example.test/api/submit', status: 200, method: 'POST' }];
  const hub = fakeHub({ answers: { network: { ok: true, text: '', data: { entries } } } });
  const ok = await runSkill(
    hub,
    's1',
    settings,
    {
      name: 'x',
      recipe: {
        ...recipe,
        steps: [recipe.steps[0]],
        assert: [{ after: 'find', network: { url: '/api/submit', status: 200 } }],
      },
    },
    { quiet: true },
  );
  assert.equal(ok.ok, true);

  const okBadStatus = await runSkill(
    hub,
    's1',
    settings,
    {
      name: 'x',
      recipe: {
        ...recipe,
        steps: [recipe.steps[0]],
        assert: [{ after: 'find', network: { url: '/api/submit', status: 500 } }],
      },
    },
    { quiet: true },
  );
  assert.equal(okBadStatus.ok, false);
  assert.equal(okBadStatus.data.failure.code, 'ASSERT_NETWORK');
  // What was seen is shown, so the model knows whether the call never happened or answered something else.
  assert.match(okBadStatus.text, /200 https:\/\/example\.test\/api\/submit/);
});

test('text can be asserted to be gone', async () => {
  const hub = fakeHub({ answers: { wait: args => ({ ok: args.textGone !== undefined, text: 'waited' }) } });
  const gone = await runSkill(
    hub,
    's1',
    settings,
    {
      name: 'x',
      recipe: { ...recipe, steps: [recipe.steps[0]], assert: [{ after: 'find', text: '提交', absent: true }] },
    },
    { quiet: true },
  );
  assert.equal(gone.ok, true);

  const stillThere = fakeHub({ answers: { wait: () => ({ ok: false, text: 'error TIMEOUT …' }) } });
  const present = await runSkill(
    stillThere,
    's1',
    settings,
    {
      name: 'x',
      recipe: { ...recipe, steps: [recipe.steps[0]], assert: [{ after: 'find', text: '提交', absent: true }] },
    },
    { quiet: true },
  );
  assert.equal(present.data.failure.code, 'ASSERT_TEXT_PRESENT');
  assert.match(present.text, /is still on the page/);
});

test('an assertion that checks nothing is a bad recipe, not a silent pass', async () => {
  const hub = fakeHub();
  const empty = await runSkill(
    hub,
    's1',
    settings,
    { name: 'x', recipe: { ...recipe, assert: [{ after: 'find' }] } },
    { quiet: true },
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.data.failure.code, 'INVALID_RECIPE');
  assert.match(empty.text, /checks nothing/);

  const orphan = await runSkill(
    hub,
    's1',
    settings,
    { name: 'x', recipe: { ...recipe, assert: [{ after: 'nowhere', text: 'x' }] } },
    { quiet: true },
  );
  assert.match(orphan.text, /no step has that id/);
});

test('resuming starts at the named step and does not run the ones before it', async () => {
  const hub = fakeHub();
  const result = await runSkill(hub, 's1', settings, { name: recipe.name, recipe }, { quiet: true, from: 'submit' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.skipped, ['find']);
  assert.deepEqual(
    hub.calls.filter(call => call.tool === 'click').map(call => call.args.target.name),
    ['提交'],
  );
  assert.match(result.text, /Ran skill "submit-order" · 1 step/);
  assert.match(result.text, /Skipped find\./);
});

test('stopping after a step leaves the rest unrun and says so', async () => {
  const hub = fakeHub();
  const result = await runSkill(hub, 's1', settings, { name: recipe.name, recipe }, { quiet: true, until: 'find' });

  assert.equal(result.ok, true);
  assert.equal(result.data.stoppedAt, 'find');
  assert.deepEqual(result.data.skipped, ['submit']);
  assert.deepEqual(
    hub.calls.filter(call => call.tool === 'click').map(call => call.args.target.name),
    ['查询'],
  );
  assert.match(result.text, /stopped after step find as asked/);
  assert.match(result.text, /Skipped submit\./);
});

test('a step id that does not exist is refused with the ids that do', async () => {
  const hub = fakeHub();
  for (const options of [{ from: 'nowhere' }, { until: 'nowhere' }]) {
    const result = await runSkill(hub, 's1', settings, { name: recipe.name, recipe }, { quiet: true, ...options });
    assert.equal(result.ok, false);
    assert.equal(result.data.failure.code, 'INVALID_ARGUMENT');
    assert.match(result.text, /The steps are find, submit\./);
  }
  assert.equal(hub.calls.filter(call => call.tool === 'click').length, 0);
});

test('a failed resumed run reports the skipped steps with the failure', async () => {
  const hub = fakeHub({
    answers: {
      click: args =>
        args.target.name === '提交'
          ? { ok: false, text: LAYER_TEXT, error: INTERCEPTED }
          : { ok: true, text: 'clicked' },
    },
  });
  const result = await runSkill(hub, 's1', settings, { name: recipe.name, recipe }, { quiet: true, from: 'submit' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.data.skipped, ['find']);
  assert.match(result.text, /Skipped find\./);
});

test('a recipe that bets on the clock says so once', async () => {
  const hub = fakeHub();
  const withWait = {
    ...recipe,
    steps: [{ id: 'settle', tool: 'wait', args: { ms: 1500 } }, ...recipe.steps],
  };
  const result = await runSkill(hub, 's1', settings, { name: recipe.name, recipe: withWait }, { quiet: true });
  assert.equal(result.ok, true);
  assert.match(result.text, /Note: 1 step waits a fixed time \(settle\); a slow page can break them\./);
});

test('parameters are checked against their declared type, and a readable value is converted', async () => {
  const hub = fakeHub();
  const typed = {
    ...recipe,
    params: {
      orderNo: { type: 'string' },
      amount: { type: 'number' },
      urgent: { type: 'boolean', required: false },
    },
    steps: [{ ...recipe.steps[0], args: {} }],
    assert: [],
  };
  const skill = { name: 'params', recipe: typed };

  // Text for a number, and "true" for a flag: both readable, both said out loud.
  const read = await runSkill(hub, 's1', settings, skill, {
    quiet: true,
    params: { orderNo: '1001', amount: '1200', urgent: 'true' },
  });
  assert.equal(read.ok, true);
  assert.match(read.text, /Note: amount arrived as text and was read as the number 1200\./);
  assert.match(read.text, /urgent arrived as "true" and was read as true\./);

  // Something that cannot be read as the declared type stops before the page is touched.
  const wrong = await runSkill(hub, 's1', settings, skill, { quiet: true, params: { orderNo: '1001', amount: 'tbd' } });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.data.failure.code, 'INVALID_PARAMS');
  assert.match(wrong.text, /Parameter amount must be a number; it was "tbd"\./);
  assert.equal(hub.calls.filter(call => call.tool === 'click').length, 1);
});

test('a bare parameter value keeps working, and its type comes from the value', async () => {
  const hub = fakeHub();
  const bare = { ...recipe, params: { orderNo: 'Q261103044498Z', count: 2 }, steps: [recipe.steps[0]], assert: [] };
  const result = await runSkill(
    hub,
    's1',
    settings,
    { name: 'bare', recipe: bare },
    {
      quiet: true,
      params: { orderNo: '1001', count: '3' },
    },
  );
  assert.equal(result.ok, true);
  // The number was declared by the recorded literal, so text that reads as a number is accepted as one.
  assert.match(result.text, /count arrived as text and was read as the number 3\./);
});

test('a default fills a missing parameter, and a bad declared type is reported', async () => {
  const hub = fakeHub();
  const withDefault = {
    ...recipe,
    params: { orderNo: { type: 'integer', default: 'Q-1' } },
    steps: [recipe.steps[0]],
    assert: [],
  };
  const result = await runSkill(hub, 's1', settings, { name: 'd', recipe: withDefault }, { quiet: true });
  assert.equal(result.ok, true);
  assert.match(
    result.text,
    /orderNo declares type "integer", which is not string, number or boolean; it is read as text\./,
  );
});

test('a failure the recipe reports is not a failed run', async () => {
  const hub = fakeHub({
    answers: {
      click: args =>
        args.target.name === '提交'
          ? { ok: false, text: LAYER_TEXT, error: INTERCEPTED }
          : { ok: true, text: 'clicked' },
    },
  });
  const reported = {
    ...recipe,
    onFail: { INTERCEPTED: 'report', '*': 'stop' },
  };
  const result = await runSkill(hub, 's1', settings, { name: reported.name, recipe: reported }, { quiet: true });

  // The recipe said this outcome is the answer, not an error: the run is ok and says why it stopped.
  assert.equal(result.ok, true);
  assert.equal(result.data.outcome, 'reported');
  assert.equal(result.data.failure.code, 'INTERCEPTED');
  assert.match(result.text, /stopped at step submit as the recipe says/);
  assert.match(result.text, /Nothing to fix: the recipe reports this outcome instead of failing\./);
});

test('a failure the recipe hands to a person stops as asked', async () => {
  const hub = fakeHub({
    answers: {
      click: () => ({
        ok: false,
        text: 'error USER_STEP\nThe payment is the user’s.\nAsk them.',
        error: { code: 'USER_STEP', message: 'The payment is the user’s.', hint: 'Ask them.', delivered: false },
      }),
    },
  });
  const asked = { ...recipe, steps: [recipe.steps[0]], onFail: { USER_STEP: 'ask' } };
  const result = await runSkill(hub, 's1', settings, { name: 'pay', recipe: asked }, { quiet: true });

  assert.equal(result.ok, false);
  assert.equal(result.data.outcome, 'asked');
  assert.match(result.text, /a person has to decide/);
  assert.match(result.text, /nothing else was run/i);
});

test('a step the recipe lets skip only skips when nothing reached the page', async () => {
  const missing = {
    ok: false,
    text: 'error NO_MATCH (nothing dispatched; safe to retry)\nNo element matches.\nTake a snapshot.',
    error: { code: 'NO_MATCH', message: 'No element matches.', hint: 'Take a snapshot.', delivered: false },
  };
  const hub = fakeHub({
    answers: { click: args => (args.target.name === '关闭' ? missing : { ok: true, text: 'clicked' }) },
  });
  const recipeWithOptional = {
    ...recipe,
    steps: [
      { id: 'close', tool: 'click', target: { role: 'button', name: '关闭' }, onFail: { NO_MATCH: 'skip' } },
      { id: 'find', tool: 'click', target: { role: 'button', name: '查询' } },
    ],
    assert: [],
  };
  const skipped = await runSkill(hub, 's1', settings, { name: 'opt', recipe: recipeWithOptional }, { quiet: true });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.data.outcome, 'done');
  assert.deepEqual(skipped.data.unskipped, ['close']);
  assert.match(skipped.text, /Skipped close after a failure, as the recipe says\./);
  assert.match(skipped.text, /✗ close/);

  // The same failure with input already delivered is not skipped: the page may be half-done.
  const delivered = { ...missing, error: { ...missing.error, delivered: true } };
  const hub2 = fakeHub({ answers: { click: () => delivered } });
  const stopped = await runSkill(hub2, 's1', settings, { name: 'opt', recipe: recipeWithOptional }, { quiet: true });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.data.outcome, 'failed');
  assert.match(stopped.text, /something may have reached the page, so the run stopped/);
});

test('a failure brings the skill own notes for it, matched by code or step', async () => {
  const hub = fakeHub({
    answers: {
      click: args =>
        args.target.name === '提交'
          ? { ok: false, text: LAYER_TEXT, error: INTERCEPTED }
          : { ok: true, text: 'clicked' },
    },
  });
  const content = [
    '---',
    'name: submit-order',
    '---',
    '',
    '## When it fails',
    '',
    '- `INTERCEPTED`: the page moved under the click. Snapshot, then run again from `submit`.',
    '- `submit` + `ASSERT_TEXT`: check whether the order already went in.',
    '- `USER_STEP`: the payment is the user’s own step.',
    '',
    '## Notes',
    '',
    '- `INTERCEPTED`: this bullet is not in the failure section.',
  ].join('\n');
  const result = await runSkill(hub, 's1', settings, { name: 'submit-order', recipe, content }, { quiet: true });

  assert.equal(result.ok, false);
  assert.equal(result.data.knowledge.length, 2);
  assert.match(result.text, /From the skill's own notes:/);
  assert.match(result.text, /the page moved under the click/);
  assert.match(result.text, /check whether the order already went in/);
  assert.doesNotMatch(result.text, /this bullet is not in the failure section/);
});

test('an unknown action in onFail is a bad recipe', async () => {
  const hub = fakeHub();
  const result = await runSkill(
    hub,
    's1',
    settings,
    { name: 'x', recipe: { ...recipe, onFail: { INTERCEPTED: 'retry' } } },
    { quiet: true },
  );
  assert.equal(result.ok, false);
  assert.equal(result.data.failure.code, 'INVALID_RECIPE');
  assert.match(result.text, /the actions are stop, report, ask and skip/);
});

test('a batch runs every item, keeps going past a failure, and reports the lot', async () => {
  let submits = 0;
  const hub = fakeHub({
    answers: {
      click: args => {
        if (args.target.name !== '提交') return { ok: true, text: 'clicked' };
        submits += 1;
        // The second order's submit fails; the batch must still run nothing else (it was the last item)…
        return submits === 2 ? { ok: false, text: LAYER_TEXT, error: INTERCEPTED } : { ok: true, text: 'clicked' };
      },
    },
  });
  const { runSkillBatch } = await import('../core/run.js');
  const result = await runSkillBatch(
    hub,
    's1',
    settings,
    { name: 'submit-order', recipe },
    {
      quiet: true,
      batch: [{ orderNo: '1001' }, { orderNo: 'Q2' }],
    },
  );

  // Two items, each one click on 查询 and one on 提交: the second item's submit fails and does not stop the batch.
  assert.equal(result.data.requested, 2);
  assert.equal(result.data.ran, 2);
  assert.equal(result.data.failed, 1);
  assert.match(result.text, /over 2 of 2 items · 1 ok, 1 failed/);
  // The item is named by its own first value, not by a number the user would have to look up.
  assert.match(result.text, /✗ Q2 · failed · INTERCEPTED at submit/);
  assert.match(result.text, /✓ 1001 · ok/);
});

test('a batch stops when the user declines, and says how many were not run', async () => {
  const declined = {
    ok: false,
    text: 'error USER_DECLINED\nThe user declined: click «提交». Nothing was dispatched.',
    error: { code: 'USER_DECLINED', message: 'The user declined.', hint: 'Ask.', delivered: false },
  };
  const hub = fakeHub({
    answers: { click: args => (args.target.name === '提交' ? declined : { ok: true, text: 'clicked' }) },
  });
  const { runSkillBatch } = await import('../core/run.js');
  const result = await runSkillBatch(
    hub,
    's1',
    settings,
    { name: 'submit-order', recipe },
    {
      quiet: true,
      batch: [{ orderNo: '1001' }, { orderNo: 'Q2' }, { orderNo: 'Q3' }],
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.data.ran, 1);
  assert.equal(result.data.outcome, 'stopped');
  assert.match(result.text, /Stopped after 1: the user declined\. 2 not run\./);
});

test('a failed run leaves a note, and the next run of the skill reads it back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-learned-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const learning = { ...settings, skillsDir: dir };
  const failing = () =>
    fakeHub({
      answers: {
        click: args =>
          args.target.name === '提交'
            ? { ok: false, text: LAYER_TEXT, error: INTERCEPTED }
            : { ok: true, text: 'clicked' },
      },
    });
  const skill = { name: 'submit-order', recipe };

  const first = await runSkill(failing(), 's1', learning, skill, { quiet: true });
  assert.equal(first.ok, false);
  // The first failure has nothing to learn from yet.
  assert.equal(first.data.learned, undefined);
  assert.doesNotMatch(first.text, /Learned from earlier failures/);

  const second = await runSkill(failing(), 's1', learning, skill, { quiet: true });
  assert.equal(second.ok, false);
  assert.equal(second.data.learned.length, 1);
  // The note says which code, which step, what the step was doing, how often and where.
  // It failed once before this run; the count goes up after the note is read, which is why this run says one.
  assert.match(second.data.learned[0], /^- seen 1× before: `INTERCEPTED` at step `submit`: click button «提交»/);
  assert.match(second.data.learned[0], /orders\/1001\/edit/);
  assert.match(second.text, /Learned from earlier failures of this skill:/);
  assert.match(second.text, /click button «提交»/);

  const saved = JSON.parse(await readFile(join(dir, '.knowledge', 'submit-order.json'), 'utf8'));
  assert.equal(saved.notes.length, 1);
  assert.equal(saved.notes[0].code, 'INTERCEPTED');
  assert.equal(saved.notes[0].count, 2);
  assert.equal(saved.notes[0].stepId, 'submit');
});

test('a dry run and a failure about the call teach the skill nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-learned-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const learning = { ...settings, skillsDir: dir };
  const skill = { name: 'submit-order', recipe };

  // A dry run is a rehearsal: it can be wrong about the page in ways a real run is not.
  const dry = await runSkill(
    fakeHub({ answers: { find: () => ({ ok: true, text: '0 matches' }) } }),
    's1',
    learning,
    skill,
    { quiet: true, dryRun: true },
  );
  assert.equal(dry.ok, false);
  assert.deepEqual(await readKnowledge(learning, 'submit-order'), []);

  // A run with no tab failed before it touched the page; there is nothing about the page to remember.
  const noTab = await runSkill(fakeHub({ owned: false }), 's1', learning, skill, { quiet: true });
  assert.equal(noTab.ok, false);
  assert.equal(noTab.data.failure.code, 'NO_LEASE');
  assert.deepEqual(await readKnowledge(learning, 'submit-order'), []);
});
