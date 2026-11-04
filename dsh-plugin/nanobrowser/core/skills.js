// Browser Skills on disk: one directory per skill holding SKILL.md (what the model reads) and recipe.json (what the
// runner executes). Files are the source of truth: git can diff them, a user can edit them, and a teammate can share
// them. Nothing here talks to Chrome.

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normalizeName(name) {
  const value = String(name ?? '')
    .trim()
    .toLowerCase();
  if (!SKILL_NAME.test(value)) {
    throw new Error(
      'A skill name is 1-64 characters: lowercase letters, digits and hyphens, starting with a letter or digit.',
    );
  }
  return value;
}

function targetLabel(target) {
  if (!target) return 'the focused element';
  if (target.name && target.role) return `${target.role} «${target.name}»`;
  if (target.name) return `«${target.name}»`;
  if (target.ref) return `[${target.ref}]`;
  if (target.role) return target.role;
  return 'the focused element';
}

function inline(value, max = 80) {
  if (value === undefined) return '';
  let text;
  if (typeof value === 'string') text = `«${value}»`;
  else if (Array.isArray(value)) text = value.map(item => inline(item, max)).join(', ');
  else if (value && typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line for a step, used in SKILL.md and in run progress. */
export function describeStep(step) {
  const args = step.args ?? {};
  const target = targetLabel(step.target);
  switch (step.tool) {
    case 'navigate':
      return `navigate ${args.url ?? args.action ?? 'the page'}`;
    case 'click':
      return `click ${target}`;
    case 'set':
      return `set ${target} = ${inline(args.value)}`;
    case 'type':
      return `type ${inline(args.text)}${step.target ? ` into ${target}` : ''}`;
    case 'press':
      return `press ${inline(args.keys)}${step.target ? ` on ${target}` : ''}`;
    case 'hover':
      return `hover ${target}`;
    case 'scroll':
      if (args.to) return `scroll to ${typeof args.to === 'string' ? args.to : targetLabel(args.to)}`;
      if (args.by) return `scroll by ${args.by.pages ?? 0} pages / ${args.by.px ?? 0} px`;
      return `scroll ${step.target ? target : 'the page'}`;
    case 'wait':
      if (args.text) return `wait for «${args.text}»`;
      if (args.textGone) return `wait for «${args.textGone}» to disappear`;
      if (args.url) return `wait for ${args.url}`;
      if (args.state) return `wait for ${target} ${args.state}`;
      return `wait ${args.ms ?? 0} ms`;
    case 'handle_dialog':
      return `${args.accept ? 'accept' : 'dismiss'} the page dialog`;
    default:
      return step.tool;
  }
}

/** The heading a hand-written SOP uses for what to do when a step fails. Anything else in that section is ignored. */
const FAIL_SECTION = /^##\s+when it fails\s*$/im;

/**
 * The bullets of a SKILL.md's "When it fails" section that apply to one failure: a bullet counts when it names the
 * failure code or the step id in backticks. Three at most, in the order the author wrote them. No section, no match:
 * nothing is invented.
 */
export function sopNotes(content, { code, stepId } = {}) {
  const text = String(content ?? '');
  const found = FAIL_SECTION.exec(text);
  if (!found) return [];
  const rest = text.slice(found.index + found[0].length);
  const end = rest.search(/^##\s+/m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const bullets = section
    .split(/\n(?=\s*[-*]\s)/)
    .map(chunk => chunk.trim())
    .filter(chunk => /^[-*]\s/.test(chunk));
  const wanted = [code, stepId].filter(value => typeof value === 'string' && value !== '');
  return bullets
    .filter(bullet => wanted.some(value => bullet.includes(`\`${value}\``)))
    .slice(0, 3)
    .map(bullet => bullet.replace(/\s*\n\s*/g, ' '));
}

/** How many notes one skill keeps, how long one field may be, and how long one rendered line may be. */
const MAX_LEARNED_NOTES = 12;
const MAX_LEARNED_FIELD = 240;
const MAX_LEARNED_LINE = 260;

/**
 * What a skill learned from its own failures. The notes live in the user's skills directory, never inside a skill: a
 * shipped skill is read-only, but it can still learn. Nothing is read or written when no directory is configured, which
 * is what a test with a bare settings object gets.
 */
function knowledgePath(settings, name) {
  const root = String(settings?.skillsDir ?? '');
  if (!root || !name) return '';
  try {
    return join(root, '.knowledge', `${normalizeName(name)}.json`);
  } catch {
    return '';
  }
}

function boundField(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_LEARNED_FIELD ? `${text.slice(0, MAX_LEARNED_FIELD - 1)}…` : text;
}

async function readNotes(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(data?.notes) ? data.notes.filter(note => note && typeof note.code === 'string') : [];
  } catch {
    return [];
  }
}

/** The notes this skill learned: `[{code, stepId?, step?, message?, hint?, url?, count, firstSeen, lastSeen}]`. */
export async function readKnowledge(settings, name) {
  const file = knowledgePath(settings, name);
  return file ? readNotes(file) : [];
}

/** Writes in flight per file: two runs of one skill must not read, change and write the same file side by side. */
const learning = new Map();

/**
 * Records a failure against a skill, so the next run of it can say what went wrong last time. One note per failure
 * kind (its code and step), so a recipe that fails the same way every day keeps a count instead of a pile of lines.
 * Returns whether anything was written; a failed write never fails the run that produced it.
 */
export async function recordFailure(settings, name, failure, tab) {
  const file = knowledgePath(settings, name);
  if (!file || !failure?.code) return false;
  const previous = learning.get(file) ?? Promise.resolve();
  const next = previous.then(() => writeNote(file, name, failure, tab)).catch(() => false);
  learning.set(file, next);
  return next;
}

async function writeNote(file, name, failure, tab) {
  await mkdir(dirname(file), { recursive: true });
  const notes = await readNotes(file);
  const stepId = failure.stepId === undefined || failure.stepId === null ? undefined : String(failure.stepId);
  const key = `${failure.code}|${stepId ?? ''}`;
  const now = new Date().toISOString();
  const at = notes.findIndex(note => `${note.code}|${note.stepId ?? ''}` === key);
  const before = at >= 0 ? notes[at] : undefined;
  // A later failure may know less than the first one (no step text, no tab): what is known is kept, not erased.
  const note = { code: String(failure.code), ...(stepId ? { stepId } : {}) };
  for (const field of ['step', 'message', 'hint']) {
    const value = boundField(failure[field]) || boundField(before?.[field]);
    if (value) note[field] = value;
  }
  const url = String(tab?.url ?? before?.url ?? '');
  if (url) note.url = url;
  if (before) {
    notes[at] = {
      ...note,
      count: Math.min(999, Number(before.count ?? 1) + 1),
      firstSeen: before.firstSeen ?? now,
      lastSeen: now,
    };
  } else {
    notes.push({ ...note, count: 1, firstSeen: now, lastSeen: now });
  }
  // The newest notes, bounded: this says what fails now, not what failed a month ago.
  notes.sort((a, b) => String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')));
  const data = { skill: name, notes: notes.slice(0, MAX_LEARNED_NOTES) };
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return true;
}

/** One learned note as a line: what failed, how often, and where it was last seen. */
function learnedLine(note) {
  const times = Number(note.count ?? 1);
  const head = [`seen ${times}× before:`, `\`${note.code}\``];
  if (note.stepId) head.push(`at step \`${note.stepId}\``);
  const what = [note.step, note.message].filter(Boolean).join(' → ');
  const tail = [note.url ? `on ${note.url}` : '', String(note.lastSeen ?? '').slice(0, 10)].filter(Boolean).join(' · ');
  const line = `- ${head.join(' ')}${what ? `: ${what}` : ''}${tail ? ` (${tail})` : ''}`;
  return line.length > MAX_LEARNED_LINE ? `${line.slice(0, MAX_LEARNED_LINE - 1)}…` : line;
}

/**
 * The learned notes that apply to one failure: the same matching as `sopNotes` (the code or the step id), most frequent
 * first, three at most, and only for what a hand-written SOP does not already say.
 */
export function learnedNotes(notes, { code, stepId } = {}) {
  const wanted = [code, stepId].filter(value => typeof value === 'string' && value !== '');
  if (wanted.length === 0) return [];
  return (Array.isArray(notes) ? notes : [])
    .filter(note => note && wanted.some(value => note.code === value || note.stepId === value))
    .sort(
      (a, b) =>
        Number(b.count ?? 0) - Number(a.count ?? 0) || String(b.lastSeen ?? '').localeCompare(String(a.lastSeen ?? '')),
    )
    .slice(0, 3)
    .map(learnedLine);
}

/** Every note a skill has learned, for a tool that shows the skill rather than a failure. */
export function learnedSummary(notes) {
  return (Array.isArray(notes) ? notes : []).map(note => {
    const head = `${note.code}${note.stepId ? ` at step ${note.stepId}` : ''} · ${Number(note.count ?? 1)}×`;
    const what = [note.step, note.message].filter(Boolean).join(' — ');
    const line = `${head}${what ? ` · ${what}` : ''}`;
    return line.length > MAX_LEARNED_LINE ? `${line.slice(0, MAX_LEARNED_LINE - 1)}…` : line;
  });
}

/** Marks a SKILL.md the recorder wrote. Anything else in that file is the user's, and is never replaced. */
export const GENERATED_SOP = '<!-- generated by browser_skill_save -->';

export function isGeneratedSop(content) {
  return String(content ?? '').includes(GENERATED_SOP);
}

/**
 * The SKILL.md the recorder writes. It is generated, and marked as such (`GENERATED_SOP`): `browser_skill_save` only
 * ever replaces a file carrying that mark, so a hand-written SOP in the same directory survives a later save. A
 * hand-written SOP can say anything the recipe cannot — a `## When it fails` section is read back by the runner.
 */
export function renderSkillMd(recipe) {
  const lines = [GENERATED_SOP, '---', `name: ${recipe.name}`, `description: ${recipe.description}`];
  if (recipe.whenToUse) lines.push(`whenToUse: ${recipe.whenToUse}`);
  lines.push('---', '', `# ${recipe.name}`, '', recipe.description, '');
  if (recipe.origin) lines.push(`Origin: ${recipe.origin}`, '');
  const params = Object.entries(recipe.params ?? {});
  if (params.length > 0) {
    lines.push('Params:', '');
    for (const [name, spec] of params) {
      lines.push(`- \`${name}\` (${spec.type ?? 'string'}${spec.required === false ? ', optional' : ', required'})`);
    }
    lines.push('');
  }
  lines.push('Steps:', '');
  recipe.steps.forEach((step, index) => lines.push(`${index + 1}. ${describeStep(step)}`));
  lines.push('');
  if ((recipe.assert ?? []).length > 0) {
    lines.push('Checks:', '');
    for (const check of recipe.assert) {
      const condition = check.text ? `text «${check.text}»` : check.url ? `url ${check.url}` : 'the expected state';
      lines.push(`- after step \`${check.after}\`: ${condition}`);
    }
    lines.push('');
  }
  lines.push(
    'Safety:',
    '',
    '- A write step (submit, send, delete, upload) still asks the user for approval in the side panel.',
  );
  if (recipe.origin) lines.push(`- This skill only runs on ${recipe.origin}.`);
  lines.push(
    '- Run this with `browser_skill_run`, not by hand: the replay is the record, and doing it by hand is a different run.',
    '- Values are recorded literally. A secret is never stored; leave that step to the user.',
    '- A failed step stops the replay; do not retry a write blindly.',
    '',
    `Run with \`browser_skill_run({ name: "${recipe.name}", params: { ... } })\`.`,
    '',
  );
  return lines.join('\n');
}

export function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content ?? ''));
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return meta;
}

/**
 * The directories a skill may live in, in the order they are searched: settings describe them, and a caller may pass
 * one or an array. The user's own directory comes first, so a skill saved there shadows one shipped with the checkout.
 */
export function skillRoots(settings) {
  return [settings?.skillsDir, settings?.builtinSkillsDir].map(value => String(value ?? '')).filter(Boolean);
}

function rootsOf(root) {
  const list = (Array.isArray(root) ? root : [root]).map(value => String(value ?? '')).filter(Boolean);
  return [...new Set(list)];
}

export async function readSkill(root, name) {
  const key = normalizeName(name);
  for (const base of rootsOf(root)) {
    const dir = join(base, key);
    try {
      const recipe = JSON.parse(await readFile(join(dir, 'recipe.json'), 'utf8'));
      const content = await readFile(join(dir, 'SKILL.md'), 'utf8');
      const meta = parseFrontmatter(content);
      return {
        name: recipe.name ?? meta.name ?? key,
        dir,
        recipe,
        content,
        description: recipe.description ?? meta.description ?? '',
        whenToUse: recipe.whenToUse ?? meta.whenToUse ?? '',
      };
    } catch {
      // Not in this root, or half written; the next root is tried before giving up.
    }
  }
  throw new Error(`No skill named ${key}; looked in ${rootsOf(root).join(', ') || 'no directory'}.`);
}

export async function skillExists(root, name) {
  for (const base of rootsOf(root)) {
    try {
      const info = await stat(join(base, normalizeName(name), 'recipe.json'));
      if (info.isFile()) return true;
    } catch {
      // Not in this root; the next one is tried.
    }
  }
  return false;
}

export async function listSkills(root) {
  const found = new Map();
  for (const base of rootsOf(root)) {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || found.has(entry.name)) continue;
      try {
        const skill = await readSkill(base, entry.name);
        // Keyed by the recipe's own name: a directory named differently from the skill inside it is the same skill, and
        // the first root that has it wins.
        if (!found.has(skill.name)) found.set(skill.name, skill);
      } catch {
        // A half-written or hand-edited directory is left out instead of breaking the catalog.
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Writes a skill. `content` is the SKILL.md to write; pass null to keep the one already on disk, which is how a
 * hand-written SOP survives a recorder saving a recipe of the same name.
 */
export async function writeSkill(root, recipe, content = renderSkillMd(recipe)) {
  const dir = join(root, recipe.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'recipe.json'), `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');
  if (content !== null) await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}
