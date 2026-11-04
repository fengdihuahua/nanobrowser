// Skills on disk: the generated SOP marker, and the rule that a recipe saved over a hand-written SOP keeps it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERATED_SOP,
  isGeneratedSop,
  learnedNotes,
  learnedSummary,
  readKnowledge,
  recordFailure,
  renderSkillMd,
  writeSkill,
} from '../core/skills.js';

const recipe = {
  name: 'find-order',
  version: 1,
  description: 'Look an order up',
  params: {},
  steps: [{ id: 's1', tool: 'click', args: {}, target: { role: 'button', name: '查询' } }],
  assert: [{ after: 's1', text: '结果' }],
};

test('the SOP the recorder writes is marked, and says how to run it', () => {
  const text = renderSkillMd(recipe);
  assert.ok(text.startsWith(GENERATED_SOP));
  assert.equal(isGeneratedSop(text), true);
  assert.match(text, /Run this with `browser_skill_run`, not by hand/);
  assert.match(text, /after step `s1`: text «结果»/);
  assert.equal(isGeneratedSop('---\nname: mine\n---\n\nMy own notes.'), false);
});

test('writing a recipe with no content keeps the SKILL.md that is there', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-skill-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true })));

  // A hand-written SOP first, then a recipe of the same name recorded later.
  await writeSkill(
    dir,
    { ...recipe, version: 1 },
    '---\nname: find-order\n---\n\nHand-written: always check the amount.',
  );
  await writeSkill(dir, { ...recipe, version: 2 }, null);

  assert.equal(
    await readFile(join(dir, 'find-order', 'SKILL.md'), 'utf8'),
    '---\nname: find-order\n---\n\nHand-written: always check the amount.',
  );
  const saved = JSON.parse(await readFile(join(dir, 'find-order', 'recipe.json'), 'utf8'));
  assert.equal(saved.version, 2);
});

test('a generated SOP is replaced when the recipe is saved again', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-skill-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true })));

  await writeSkill(dir, { ...recipe, version: 1, description: 'first' });
  await writeFile(join(dir, 'find-order', 'recipe.json'), '{}');
  await writeSkill(dir, { ...recipe, version: 2, description: 'second' });
  const sop = await readFile(join(dir, 'find-order', 'SKILL.md'), 'utf8');
  assert.match(sop, /second/);
  assert.ok(sop.startsWith(GENERATED_SOP));
});

test('a learned note is one line per failure kind, counted, and stays out of the skill folder', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nb-skill-'));
  t.after(() => import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true })));
  const settings = { skillsDir: dir };

  assert.deepEqual(await readKnowledge(settings, 'find-order'), []);
  assert.equal(
    await recordFailure(
      settings,
      'find-order',
      { code: 'NO_MATCH', stepId: 's1', step: 'click button «提交»', message: 'No element matches.' },
      { url: 'https://example.test/orders' },
    ),
    true,
  );
  // The same failure again is the same note with a count, not a second line.
  await recordFailure(settings, 'find-order', { code: 'NO_MATCH', stepId: 's1', message: 'No element matches.' });
  await recordFailure(settings, 'find-order', { code: 'AMBIGUOUS_TARGET', stepId: 's1', message: 'Two matches.' });

  const notes = await readKnowledge(settings, 'find-order');
  assert.equal(notes.length, 2);
  const repeated = notes.find(note => note.code === 'NO_MATCH');
  assert.equal(repeated.count, 2);
  assert.equal(repeated.url, 'https://example.test/orders');
  assert.equal(repeated.stepId, 's1');
  assert.equal(notes.find(note => note.code === 'AMBIGUOUS_TARGET').count, 1);

  // The file is the user's, under their skills directory, and is plain JSON a teammate can read.
  const file = join(dir, '.knowledge', 'find-order.json');
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.skill, 'find-order');
  assert.equal(written.notes.length, 2);

  // No directory configured: nothing to read, nothing written.
  assert.deepEqual(await readKnowledge({}, 'find-order'), []);
  assert.equal(await recordFailure({}, 'find-order', { code: 'NO_MATCH' }), false);
});

test('learned notes are matched the way the SOP is, most frequent first, three at most', () => {
  const notes = [
    { code: 'NO_MATCH', stepId: 's1', message: 'one', count: 1, lastSeen: '2026-11-01T00:00:00Z' },
    { code: 'NO_MATCH', stepId: 's2', message: 'two', count: 5, lastSeen: '2026-11-02T00:00:00Z' },
    { code: 'ASSERT_TEXT', stepId: 's3', message: 'three', count: 3, lastSeen: '2026-11-03T00:00:00Z' },
    { code: 'USER_STEP', stepId: 's4', message: 'four', count: 1, lastSeen: '2026-11-04T00:00:00Z' },
  ];
  const byCode = learnedNotes(notes, { code: 'NO_MATCH', stepId: 's1' });
  assert.equal(byCode.length, 2);
  assert.match(byCode[0], /^- seen 5× before: `NO_MATCH` at step `s2`: two/);
  assert.match(byCode[1], /one/);
  // Only codes and steps that were asked about; nothing invented.
  assert.deepEqual(learnedNotes(notes, { code: 'PAGE_NOT_SUPPORTED' }), []);
  assert.deepEqual(learnedNotes([], { code: 'NO_MATCH' }), []);
  // A summary is a line per note, for a tool that shows the skill rather than a failure.
  assert.equal(learnedSummary(notes).length, 4);
  assert.match(learnedSummary(notes)[0], /^NO_MATCH at step s1 · 1× · one$/);
});
