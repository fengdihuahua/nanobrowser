#!/usr/bin/env node
// Checks that every name the docs use still exists in the code.
//
// A renamed tool, a dropped config key, a moved file or a broken link between pages fails here instead of rotting the
// docs. It reads docs/design.md, docs/reference.md, docs/mcp.md, docs/roadmap.md, docs/runbook.md and docs/adr/*.md, so those are the
// pages that must stay true. Retired pages are not checked until they move into this set.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTION_TOOLS, TOOLS } from '../dsh-plugin/nanobrowser/core/tools.js';
import { resolveConfig } from '../dsh-plugin/nanobrowser/core/config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'dsh-plugin/nanobrowser');
const DOC_LIST = [
  'docs/design.md',
  'docs/reference.md',
  'docs/mcp.md',
  'docs/mcp-clients.md',
  'docs/roadmap.md',
  'docs/runbook.md',
];
const failures = [];

function fail(file, message) {
  failures.push(`${file}: ${message}`);
}

function read(file) {
  return readFileSync(join(ROOT, file), 'utf8');
}

/** Every tool name a model can see: the 18 browser tools plus the ones the plugin registers itself. */
function toolNames() {
  const names = new Set(TOOLS.map(tool => `nanobrowser_${tool.name}`));
  const files = ['index.js', 'host/skills.js', 'host/user-step.js', 'host/approvals.js', 'host/sidebar.js'];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(PLUGIN, file), 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/name:\s*'(nanobrowser_[a-z_]+|browser_skill_[a-z_]+)'/g)) names.add(match[1]);
  }
  return names;
}

const tools = toolNames();
const configKeys = new Set(Object.keys(resolveConfig({})));
const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts));
/** pnpm's own commands, which are not scripts in package.json. */
const PNPM_COMMANDS = new Set(['install', 'add', 'remove', 'update', 'exec', 'dlx', 'run', 'why', 'list', 'outdated']);

/** A token that looks like a repo path: it has a directory and a real file extension. */
function asPath(token) {
  if (token.includes('://') || token.startsWith('~') || token.includes('{{') || token.includes('<')) return undefined;
  if (token.includes('*') || token.startsWith('-')) return undefined;
  const cleaned = token.replace(/#.*$/, '').replace(/:\d+(-\d+)?$/, '');
  if (!cleaned.includes('/') || !/\.[a-z0-9]+$/i.test(cleaned)) return undefined;
  return cleaned;
}

function pathExists(token, docDir) {
  const cleaned = asPath(token.replace(/^\.\//, ''));
  if (!cleaned) return true;
  return [join(ROOT, cleaned), join(PLUGIN, cleaned), join(docDir, cleaned)].some(candidate => existsSync(candidate));
}

const docs = [
  ...DOC_LIST,
  ...readdirSync(join(ROOT, 'docs/adr'))
    .filter(name => name.endsWith('.md'))
    .map(name => `docs/adr/${name}`),
];
const texts = new Map(docs.map(file => [file, read(file)]));

for (const [file, text] of texts) {
  const docDir = join(ROOT, dirname(file));

  // Names in inline code: tools, pnpm scripts, repo paths.
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim();
    const tool = /^(nanobrowser_[a-z_]+|browser_skill_[a-z_]+|skill_[a-z_]+)$/.exec(token);
    if (tool) {
      const name = tool[1].startsWith('skill_') ? `browser_${tool[1]}` : tool[1];
      if (!tools.has(name)) fail(file, `unknown tool \`${token}\``);
      continue;
    }
    const command = /^pnpm ([a-z][\w:-]*)/.exec(token);
    if (command && !scripts.has(command[1]) && !PNPM_COMMANDS.has(command[1]))
      fail(file, `unknown script \`pnpm ${command[1]}\``);
    if (!pathExists(token, docDir)) fail(file, `missing path \`${token}\``);
  }

  // Links between pages must resolve, or a reader lands on a 404.
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = match[1];
    if (/^(https?:|mailto:)/.test(href)) continue;
    const target = href.split('#')[0];
    if (!target) continue;
    if (!existsSync(join(docDir, target))) fail(file, `broken link \`${href}\``);
  }
}

// The reference is the completeness list: every tool and every config key must be named there.
const reference = texts.get('docs/reference.md');
for (const tool of TOOLS) {
  if (!reference.includes(`nanobrowser_${tool.name}`) && !reference.includes(`\`${tool.name}\``)) {
    fail('docs/reference.md', `browser tool \`${tool.name}\` is not documented`);
  }
}
for (const key of configKeys) {
  if (!reference.includes(`\`${key}\``)) fail('docs/reference.md', `config key \`${key}\` is not documented`);
}
for (const step of ACTION_TOOLS) {
  if (!reference.includes(`\`${step}\``)) fail('docs/reference.md', `recipe step tool \`${step}\` is not documented`);
}

// A key in the reference's config table must exist in core/config.js, so a renamed key cannot linger.
const configSection = reference.slice(reference.indexOf('## 4. 配置项'), reference.indexOf('## 5.'));
for (const match of configSection.matchAll(/^\|\s*`([A-Za-z][\w]*)`\s*\|/gm)) {
  if (!configKeys.has(match[1])) fail('docs/reference.md', `unknown config key \`${match[1]}\``);
}

if (failures.length > 0) {
  console.error(`docs-check: ${failures.length} problem${failures.length === 1 ? '' : 's'}`);
  for (const line of failures) console.error(`  ✗ ${line}`);
  process.exit(1);
}
console.log(
  `docs-check: ${docs.length} pages, ${tools.size} tools, ${configKeys.size} config keys, ${scripts.size} scripts — ok`,
);
