// Browser Skills on disk: one directory per skill holding SKILL.md (what the model reads) and recipe.json (what the
// runner executes). Files are the source of truth: git can diff them, a user can edit them, and a teammate can share
// them. Nothing here talks to Chrome.

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

export function renderSkillMd(recipe) {
  const lines = ['---', `name: ${recipe.name}`, `description: ${recipe.description}`];
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

export async function readSkill(root, name) {
  const key = normalizeName(name);
  const dir = join(root, key);
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
}

export async function skillExists(root, name) {
  try {
    const info = await stat(join(root, normalizeName(name), 'recipe.json'));
    return info.isFile();
  } catch {
    return false;
  }
}

export async function listSkills(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      skills.push(await readSkill(root, entry.name));
    } catch {
      // A half-written or hand-edited directory is left out instead of breaking the catalog.
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeSkill(root, recipe, content = renderSkillMd(recipe)) {
  const dir = join(root, recipe.name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'recipe.json'), `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');
  await writeFile(join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}
