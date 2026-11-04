// Run a Browser Skill through the hub.
//
// The recipe is deterministic: the model is not asked to re-decide each step. The layer still classifies writes and
// asks the user for approval; a failed step or assertion stops the run. The panel sees progress through `say` notes.

import { ACTION_TOOLS } from './tools.js';
import { describeStep, learnedNotes, readKnowledge, recordFailure, sopNotes } from './skills.js';

const MAX_TEXT = 240;
/** A failed step's text is not shortened to a line; it is only cut when it is absurdly long. */
const MAX_FAILURE_TEXT = 4000;
/** How long a text assertion keeps checking before it gives up. */
const CHECK_WAIT_MS = 2000;
/** How long one check of a text assertion lasts: short, because a passing assertion should not cost the whole budget. */
const CHECK_POLL_MS = 250;

function short(text) {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function substitute(value, params) {
  if (typeof value === 'string') {
    const whole = /^\{\{([a-zA-Z0-9_.:-]+)\}\}$/.exec(value);
    if (whole && Object.hasOwn(params, whole[1])) return params[whole[1]];
    return value.replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (_, key) =>
      Object.hasOwn(params, key) ? String(params[key]) : `{{${key}}}`,
    );
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, params));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = substitute(item, params);
    return out;
  }
  return value;
}

const PARAM_TYPES = new Set(['string', 'number', 'boolean']);

/**
 * One parameter, however it was written. A bare value is what a hand-written or recorded recipe often has; its type is
 * whatever the value is, and it is required. A declared type that is not string/number/boolean is read as text and
 * said out loud, because a typo there would otherwise silently disable the check.
 */
function normalizeSpec(name, spec, notes) {
  if (spec === null || spec === undefined || typeof spec !== 'object') {
    const type = typeof spec === 'number' ? 'number' : typeof spec === 'boolean' ? 'boolean' : 'string';
    return { type, required: true };
  }
  if (spec.type !== undefined && !PARAM_TYPES.has(spec.type)) {
    notes.push(
      `${name} declares type "${String(spec.type)}", which is not string, number or boolean; it is read as text.`,
    );
  }
  return {
    type: PARAM_TYPES.has(spec.type) ? spec.type : 'string',
    required: spec.required !== false,
    ...(spec.default !== undefined ? { default: spec.default } : {}),
  };
}

/** A value read as the declared type, when that reading is unambiguous; a note says it happened. */
function coerce(name, value, type, notes) {
  if (type === 'number') {
    if (typeof value === 'number') return { ok: true, value };
    const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    if (Number.isFinite(number)) {
      notes.push(`${name} arrived as text and was read as the number ${number}.`);
      return { ok: true, value: number };
    }
    return { ok: false, expected: 'a number' };
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === 'false' || value === 1 || value === 0) {
      const flag = value === 'true' || value === 1;
      notes.push(`${name} arrived as ${JSON.stringify(value)} and was read as ${flag}.`);
      return { ok: true, value: flag };
    }
    return { ok: false, expected: 'true or false' };
  }
  if (typeof value === 'string') return { ok: true, value };
  if (typeof value === 'number' || typeof value === 'boolean') {
    notes.push(`${name} arrived as ${typeof value} and was read as text.`);
    return { ok: true, value: String(value) };
  }
  return { ok: false, expected: 'text' };
}

function resolveParams(recipe, provided) {
  const params = provided && typeof provided === 'object' ? { ...provided } : {};
  const missing = [];
  const notes = [];
  for (const [name, spec] of Object.entries(recipe.params ?? {})) {
    const declared = normalizeSpec(name, spec, notes);
    if (params[name] === undefined || params[name] === null) {
      if (declared.default !== undefined) params[name] = declared.default;
      else if (declared.required) missing.push(name);
      continue;
    }
    const read = coerce(name, params[name], declared.type, notes);
    if (!read.ok) {
      return {
        ok: false,
        code: 'INVALID_PARAMS',
        text: `Parameter ${name} must be ${read.expected}; it was ${JSON.stringify(params[name])}.`,
        hint: `Pass ${read.expected} in params, or fix the value you passed.`,
      };
    }
    params[name] = read.value;
  }
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_PARAMS',
      text: `Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
      hint: 'Pass them in params, or give them a default in the recipe.',
    };
  }
  if (/\{\{secret:/.test(JSON.stringify(recipe))) {
    return {
      ok: false,
      code: 'SECRET_PARAM',
      text: 'This skill contains a secret parameter. Secret values are never stored or passed to the model.',
      hint: 'Do that step yourself; nothing around it was run.',
    };
  }
  return { ok: true, params, notes };
}

const ON_FAIL_ACTIONS = new Set(['stop', 'report', 'ask', 'skip']);
/** The action a recipe names, and the outcome the run reports. */
const ACTION_OUTCOME = { report: 'reported', ask: 'asked' };

/** One lookup in an `onFail` table: the code itself first, then the `*` fallback. */
function actionFor(table, code) {
  if (!table || typeof table !== 'object') return undefined;
  if (typeof table[code] === 'string') return table[code];
  return typeof table['*'] === 'string' ? table['*'] : undefined;
}

/** What to do about this failure: the step's table, then the recipe's, then stop. */
function resolveOnFail(recipe, step, code) {
  return actionFor(step?.onFail, code) ?? actionFor(recipe?.onFail, code) ?? 'stop';
}

function checkOnFail(table, where) {
  if (table === undefined) return;
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`${where} onFail must be an object of failure code to action.`);
  }
  for (const [code, action] of Object.entries(table)) {
    if (!ON_FAIL_ACTIONS.has(action)) {
      throw new Error(
        `${where} onFail maps ${code} to "${String(action)}"; the actions are stop, report, ask and skip.`,
      );
    }
  }
}

function validateRecipe(recipe, settings) {
  if (!recipe || typeof recipe !== 'object') throw new Error('The skill has no recipe.');
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) throw new Error('The skill has no steps.');
  if (recipe.steps.length > settings.maxSteps) {
    throw new Error(`The skill has ${recipe.steps.length} steps; the limit is ${settings.maxSteps}.`);
  }
  checkOnFail(recipe.onFail, 'The recipe');
  for (const step of recipe.steps) checkOnFail(step.onFail, `Step ${step.id ?? step.tool}`);
  for (const check of recipe.assert ?? []) {
    if (typeof check?.after !== 'string') throw new Error('Every assertion needs an "after" naming its step.');
    const known =
      typeof check.text === 'string' ||
      typeof check.url === 'string' ||
      typeof check.consoleErrors === 'number' ||
      (check.network && typeof check.network === 'object');
    if (!known) {
      throw new Error(
        `The assertion after ${check.after} checks nothing: give it text, url, consoleErrors or network.`,
      );
    }
    if (!recipe.steps.some(step => step.id === check.after)) {
      throw new Error(`An assertion says after ${check.after}, and no step has that id.`);
    }
  }
  for (const step of recipe.steps) {
    if (!ACTION_TOOLS.has(step.tool)) throw new Error(`Unknown skill step tool: ${step.tool}`);
    if ((step.tool === 'click' || step.tool === 'set' || step.tool === 'hover') && !step.target) {
      throw new Error(`Step ${step.id ?? step.tool} needs a target.`);
    }
    if (step.tool === 'set' && step.args?.value === undefined) {
      throw new Error(`Step ${step.id ?? step.tool} needs a value.`);
    }
  }
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

async function activeTab(hub, clientId, signal) {
  const result = await hub.call(clientId, 'tabs', { action: 'list' }, { signal });
  if (!result || result.ok === false) return undefined;
  const match = /\*\s+tab\s+(\d+)\s+·\s+«(.*?)»\s+·\s+«(.*?)»/.exec(String(result.text ?? ''));
  return match ? { tabId: Number(match[1]), title: match[2], url: match[3] } : undefined;
}

async function say(hub, clientId, text, signal) {
  try {
    await hub.call(clientId, 'say', { text }, { signal });
  } catch {
    // Progress notes are a convenience; a disconnected panel must not fail the run.
  }
}

async function dryRunStep(hub, clientId, step, args, target, signal) {
  if (step.tool === 'navigate' || step.tool === 'wait' || step.tool === 'handle_dialog') {
    return { ok: true, text: `would ${describeStep({ ...step, args, target })}` };
  }
  if (!target) return { ok: true, text: `would ${describeStep({ ...step, args, target })}` };
  const findArgs = { limit: 5 };
  if (target.role) findArgs.role = target.role;
  if (target.name) findArgs.name = target.name;
  if (target.within) findArgs.within = target.within;
  const found = await hub.call(clientId, 'find', findArgs, { signal });
  if (!found || found.ok === false) {
    return {
      ok: false,
      text: `Target ${describeStep({ ...step, args, target })} could not be resolved: ${short(found?.text)}`,
    };
  }
  if (/no (element|match)|0 matches/i.test(String(found.text ?? ''))) {
    return { ok: false, text: `Target ${describeStep({ ...step, args, target })} was not found.` };
  }
  return { ok: true, text: `would ${describeStep({ ...step, args, target })}` };
}

/**
 * The assertions that follow one step. Four kinds: text present, text gone, URL, and the two the extension reports
 * structured data for, console errors and network status. A check reads the live page or a fresh capture; it never
 * trusts an observation from an earlier step.
 */
async function checkAssertions(hub, clientId, recipe, stepId, signal) {
  const checks = (recipe.assert ?? []).filter(check => check.after === stepId);
  for (const check of checks) {
    if (typeof check.text === 'string') {
      const gone = check.absent === true;
      // `find` reads the latest observation; a check must read the live page, so use `wait`.
      // A short poll first: the common case is that the page already shows what the check wants, and waiting two
      // seconds for it on every step is what made a 20-step replay feel slow.
      let waited;
      for (let spent = 0; spent < CHECK_WAIT_MS; spent += CHECK_POLL_MS) {
        const slice = Math.min(CHECK_POLL_MS, CHECK_WAIT_MS - spent);
        waited = gone
          ? await hub.call(clientId, 'wait', { textGone: check.text, ms: slice }, { signal })
          : await hub.call(clientId, 'wait', { text: check.text, ms: slice }, { signal });
        if (waited && waited.ok !== false) break;
      }
      if (!waited || waited.ok === false) {
        return {
          ok: false,
          code: gone ? 'ASSERT_TEXT_PRESENT' : 'ASSERT_TEXT',
          text: gone
            ? `After ${stepId}, the text «${check.text}» is still on the page.`
            : `After ${stepId}, the text «${check.text}» was not found within ${CHECK_WAIT_MS / 1000}s.`,
          detail: String(waited?.text ?? ''),
        };
      }
      continue;
    }
    if (typeof check.url === 'string') {
      const tab = await activeTab(hub, clientId, signal);
      if (!tab || !String(tab.url).includes(check.url)) {
        return {
          ok: false,
          code: 'ASSERT_URL',
          text: `After ${stepId}, the URL did not contain ${check.url}${tab ? ` (it is ${tab.url})` : ''}.`,
          detail: '',
        };
      }
      continue;
    }
    if (typeof check.consoleErrors === 'number') {
      const read = await hub.call(clientId, 'console', { level: 'error', limit: 200 }, { signal });
      if (!read || read.ok === false) {
        return {
          ok: false,
          code: 'ASSERT_CONSOLE',
          text: `After ${stepId}, the console could not be read.`,
          detail: String(read?.text ?? ''),
        };
      }
      const entries = Array.isArray(read.data?.entries) ? read.data.entries : [];
      if (entries.length > check.consoleErrors) {
        return {
          ok: false,
          code: 'ASSERT_CONSOLE',
          text: `After ${stepId}, the console has ${entries.length} error${entries.length === 1 ? '' : 's'}; at most ${check.consoleErrors} allowed.`,
          detail: entries
            .slice(0, 3)
            .map(entry => `[${entry.level}] ${entry.text}`)
            .join('\n'),
        };
      }
      continue;
    }
    if (check.network && typeof check.network === 'object') {
      const wanted = check.network;
      const filter = typeof wanted.url === 'string' ? wanted.url : '';
      const read = await hub.call(clientId, 'network', { filter, limit: 200 }, { signal });
      if (!read || read.ok === false) {
        return {
          ok: false,
          code: 'ASSERT_NETWORK',
          text: `After ${stepId}, the network requests could not be read.`,
          detail: String(read?.text ?? ''),
        };
      }
      const entries = Array.isArray(read.data?.entries) ? read.data.entries : [];
      const match = entries.find(
        entry =>
          (filter === '' || String(entry.url ?? '').includes(filter)) &&
          (wanted.status === undefined || entry.status === wanted.status),
      );
      if (!match) {
        const seen = entries
          .slice(-5)
          .map(entry => `${entry.failed ? `FAILED ${entry.failed}` : (entry.status ?? 'pending')} ${entry.url}`)
          .join('\n');
        return {
          ok: false,
          code: 'ASSERT_NETWORK',
          text: `After ${stepId}, no request${filter ? ` matching ${filter}` : ''}${wanted.status === undefined ? '' : ` with status ${wanted.status}`} was seen.`,
          detail: seen,
        };
      }
      continue;
    }
  }
  return { ok: true };
}

function secondsSince(started) {
  return ((Date.now() - started) / 1000).toFixed(1);
}

/**
 * A recipe that bets on the clock. Said once per run: it is a property of the recipe, and the fix is to re-record the
 * wait as a condition (the recorder now does that on its own when the next step names a target).
 */
function fixedWaitNote(recipe) {
  const waits = (recipe.steps ?? []).filter(
    step =>
      step.tool === 'wait' &&
      step.args?.ms !== undefined &&
      step.args.text === undefined &&
      step.args.url === undefined &&
      step.args.state === undefined &&
      step.target === undefined,
  );
  if (waits.length === 0) return undefined;
  const ids = waits.map(step => step.id).join(', ');
  return `Note: ${waits.length} step${waits.length === 1 ? ' waits' : 's wait'} a fixed time (${ids}); a slow page can break them.`;
}

/** Writes the recipe asserts nothing about: the run cannot tell success from a silent failure. */
function uncheckedLine(unchecked) {
  if (unchecked.length === 0) return undefined;
  const steps = unchecked.map(entry => `${entry.step} (${entry.kind})`).join(', ');
  return `⚠ Nothing checks ${steps}: the layer classified the action as a write, so a silent failure would look like success.`;
}

function summary(
  skill,
  stepResults,
  assertionResults,
  started,
  { unchecked = [], skipped = [], unskipped = [], stoppedAt, notes = [] } = {},
) {
  const count = `${stepResults.length} step${stepResults.length === 1 ? '' : 's'}`;
  const head = stoppedAt
    ? `Skill "${skill.name}" stopped after step ${stoppedAt} as asked · ${secondsSince(started)}s`
    : `Ran skill "${skill.name}" · ${count} · ${secondsSince(started)}s`;
  const lines = [head];
  for (const step of stepResults) lines.push(`${step.ok ? '✓' : '✗'} ${step.id} · ${short(step.text)}`);
  for (const check of assertionResults) lines.push(`✓ check after ${check.after} · ${short(check.text)}`);
  const warning = uncheckedLine(unchecked);
  if (warning) lines.push(warning);
  if (skipped.length > 0) lines.push(`Skipped ${skipped.join(', ')}.`);
  if (unskipped.length > 0) lines.push(`Skipped ${unskipped.join(', ')} after a failure, as the recipe says.`);
  const clock = fixedWaitNote(skill.recipe);
  if (clock) lines.push(clock);
  if (notes.length > 0) lines.push(`Note: ${notes.join(' ')}`);
  if (skill.recipe?.needsReview) {
    lines.push(
      'Note: some targets were recorded as refs because their role and name could not be resolved; review the recipe.',
    );
  }
  return lines.join('\n');
}

/** A failure the runner decided itself: its text is the message and the next step, one after the other. */
function runnerFailure({ code, message, hint, delivered = false, stepId, tool }) {
  return { code, message, hint, delivered, stepId, tool, text: [message, hint].filter(Boolean).join('\n') };
}

/**
 * The failure in full. The layer's own text already says what happened, whether anything reached the page and what to
 * do next; it is only cut when it is absurdly long, and the cut is stated (invariant 7: degrade loudly).
 */
function detail(failure) {
  const value = String(failure.text ?? '').trim();
  return value.length > MAX_FAILURE_TEXT
    ? `${value.slice(0, MAX_FAILURE_TEXT)}\n… (cut at ${MAX_FAILURE_TEXT} characters)`
    : value;
}

function whereLine(tab) {
  return tab
    ? `Where: tab ${tab.tabId} «${tab.title}» — ${tab.url}`
    : 'Where: no tab is known right now (this session holds none, or the page could not be read).';
}

/**
 * The text of a failed run: what each step did, the failure in full, and where the tab is now. A failed step shows its
 * tool on its line and its text below, uncut: the code, the "was anything dispatched" and the hint are what let the
 * model take over instead of guessing.
 */
/** The line that says how the run ended, in the recipe's own terms. */
/** Failures that say something about the call, not about the page: a learned note about them would teach nothing. */
const NOT_LEARNED = new Set([
  'CANCELLED',
  'NO_LEASE',
  'INVALID_RECIPE',
  'INVALID_PARAMS',
  'MISSING_PARAMS',
  'SECRET_PARAM',
  'ORIGIN_MISMATCH',
]);

/**
 * Records one failed run against its skill, so the next run of it can say what went wrong last time. A note is a hint,
 * not a record of work: a failure to write it changes nothing about the run.
 */
async function learnFrom(settings, skill, failure, tab) {
  if (!failure?.stepId || NOT_LEARNED.has(failure.code)) return;
  const step = (skill?.recipe?.steps ?? []).find(candidate => candidate.id === failure.stepId);
  await recordFailure(
    settings,
    skill.name,
    {
      code: failure.code,
      stepId: failure.stepId,
      step: step ? describeStep(step) : undefined,
      message: failure.message,
      hint: failure.hint,
    },
    tab,
  ).catch(() => undefined);
}

const OUTCOME_HEAD = {
  failed: failure => (failure.stepId ? `failed at step ${failure.stepId}` : 'failed before it started'),
  reported: failure => `stopped at step ${failure.stepId ?? 'the start'} as the recipe says`,
  asked: failure => `stopped at step ${failure.stepId ?? 'the start'}: a person has to decide`,
};

function failureText(
  skill,
  stepResults,
  assertionResults,
  started,
  failure,
  tab,
  { unchecked = [], skipped = [], unskipped = [], notes = [], outcome = 'failed', knowledge = [], learned = [] } = {},
) {
  const head = (OUTCOME_HEAD[outcome] ?? OUTCOME_HEAD.failed)(failure);
  const lines = [`Skill "${skill.name}" ${head} · ${secondsSince(started)}s`];
  for (const step of stepResults) {
    lines.push(`${step.ok ? '✓' : '✗'} ${step.id} · ${step.ok ? short(step.text) : step.tool}`);
  }
  for (const check of assertionResults) {
    if (check.ok) lines.push(`✓ check after ${check.after} · ${short(check.text)}`);
  }
  for (const line of detail(failure).split('\n')) lines.push(`   ${line}`);
  if (failure.note) lines.push(`   ${failure.note}`);
  if (knowledge.length > 0) {
    // The SOP's own words for this failure: matched by code or step id, never generated.
    lines.push("From the skill's own notes:");
    for (const bullet of knowledge) lines.push(`   ${bullet}`);
  }
  if (learned.length > 0) {
    // What earlier runs of this skill reported for the same code or step: the skill's own record, not the model's guess.
    lines.push('Learned from earlier failures of this skill:');
    for (const bullet of learned) lines.push(`   ${bullet}`);
  }
  if (outcome === 'reported') lines.push('Nothing to fix: the recipe reports this outcome instead of failing.');
  if (outcome === 'asked') lines.push('A person has to decide this one; nothing else was run.');
  const warning = uncheckedLine(unchecked);
  if (warning) lines.push(warning);
  if (skipped.length > 0) lines.push(`Skipped ${skipped.join(', ')}.`);
  if (unskipped.length > 0) lines.push(`Skipped ${unskipped.join(', ')} after a failure, as the recipe says.`);
  const clock = fixedWaitNote(skill.recipe);
  if (clock) lines.push(clock);
  if (notes.length > 0) lines.push(`Note: ${notes.join(' ')}`);
  lines.push(whereLine(tab));
  if (skill.recipe?.needsReview) {
    lines.push(
      'Note: some targets were recorded as refs because their role and name could not be resolved; review the recipe.',
    );
  }
  return lines.join('\n');
}

/**
 * How a run ended. `reported` is the recipe's own decision that this is not a failure, so it comes back `ok: true`;
 * everything else that stopped early did not do what it was asked. `data.failure` carries the facts for whoever matches
 * on them, `data.knowledge` the SOP's own words for it, and `text` is what the model reads.
 */
async function finish(hub, clientId, signal, parts) {
  const {
    skill,
    settings,
    dryRun = false,
    stepResults,
    assertionResults,
    started,
    failures = [],
    unchecked = [],
    skipped = [],
    unskipped = [],
    notes = [],
    outcome = 'failed',
  } = parts;
  const failure = failures[0];
  // A run can fail because the hub is gone; the failure itself must still come back.
  const tab = await activeTab(hub, clientId, signal).catch(() => undefined);
  const knowledge = failure ? sopNotes(skill?.content, { code: failure.code, stepId: failure.stepId }) : [];
  // The skill's own record of this failure, read before this one is written: a note never explains the failure that
  // created it. A hand-written SOP comes first and leaves room for fewer learned lines.
  const learned = failure
    ? learnedNotes(await readKnowledge(settings, skill?.name), {
        code: failure.code,
        stepId: failure.stepId,
      }).slice(0, knowledge.length > 0 ? 2 : 3)
    : [];
  // Only a real failed run teaches: a dry run, a cancellation and a bad call say nothing about the page.
  if (failure && outcome === 'failed' && !dryRun) await learnFrom(settings, skill, failure, tab);
  return {
    ok: outcome === 'reported',
    text: failureText(skill, stepResults, assertionResults, started, failure, tab, {
      unchecked,
      skipped,
      unskipped,
      notes,
      outcome,
      knowledge,
      learned,
    }),
    data: {
      name: skill?.name,
      outcome,
      failedStep: failure?.stepId,
      steps: stepResults,
      assertions: assertionResults,
      unchecked: unchecked.map(entry => entry.step),
      skipped,
      unskipped,
      durationMs: Date.now() - started,
      ...(failure
        ? { failure: { ...failure, ...(tab ? { tabId: tab.tabId, url: tab.url, title: tab.title } : {}) } }
        : {}),
      ...(knowledge.length > 0 ? { knowledge } : {}),
      ...(learned.length > 0 ? { learned } : {}),
    },
  };
}

function cancelled() {
  return runnerFailure({
    code: 'CANCELLED',
    message: 'The skill was cancelled.',
    hint: 'What ran before the stop stays done. Check the page before running the skill again.',
    delivered: 'unknown',
  });
}

/**
 * Runs one skill. Returns `{ok, text, data}`; a failed step or check is `ok: false`, not an exception, so the model
 * can read exactly where it stopped, whether anything reached the page, and what to do next.
 */
export async function runSkill(hub, clientId, settings, skill, options = {}) {
  const started = Date.now();
  const stepResults = [];
  const assertionResults = [];
  const unchecked = [];
  const skipped = [];
  const unskipped = [];
  const failures = [];
  const notes = [];
  const signal = options.signal;
  const keep = () => ({ skill, stepResults, assertionResults, unchecked, skipped, unskipped, notes });
  const stop = (failure, outcome = 'failed') => {
    failures.push(failure);
    return finish(hub, clientId, signal, {
      ...keep(),
      settings,
      started,
      failures,
      outcome,
      // A dry run resolves targets without acting, so it can be wrong about the page in ways a real run is not.
      dryRun: options.dryRun === true,
    });
  };
  let recipe;
  try {
    recipe = skill.recipe;
    validateRecipe(recipe, settings);
  } catch (error) {
    return stop(
      runnerFailure({
        code: 'INVALID_RECIPE',
        message: String(error?.message ?? error),
        hint: 'Fix the recipe file, then run the skill again.',
      }),
    );
  }
  const params = resolveParams(recipe, options.params);
  if (!params.ok) {
    return stop(runnerFailure({ code: params.code, message: params.text, hint: params.hint }));
  }
  // A value that had to be read as another type is worth saying: the recipe's declared type is the contract.
  notes.push(...(params.notes ?? []));
  const stepDelayMs = Math.max(0, Math.min(2000, Number(options.stepDelayMs ?? settings.stepDelayMs)));
  const dryRun = options.dryRun === true;
  const quiet = options.quiet === true;

  // Resuming starts at a step: the scene is where the failed run left it, so earlier steps are not run again.
  const from = String(options.from ?? '');
  const until = String(options.until ?? '');
  const fromIndex = from ? recipe.steps.findIndex(step => step.id === from) : 0;
  const untilIndex = until ? recipe.steps.findIndex(step => step.id === until) : -1;
  const stepIds = recipe.steps.map(step => step.id).join(', ');
  if (from && fromIndex < 0) {
    return stop(
      runnerFailure({
        code: 'INVALID_ARGUMENT',
        message: `No step named ${from} to resume from.`,
        hint: `The steps are ${stepIds}.`,
      }),
    );
  }
  if (until && untilIndex < 0) {
    return stop(
      runnerFailure({
        code: 'INVALID_ARGUMENT',
        message: `No step named ${until} to stop after.`,
        hint: `The steps are ${stepIds}.`,
      }),
    );
  }

  if (hub.ownedTabId(String(clientId)) === null) {
    return stop(
      runnerFailure({
        code: 'NO_LEASE',
        message: 'This session holds no browser tab.',
        hint: 'Call nanobrowser_attach, then run the skill again.',
      }),
    );
  }

  if (recipe.origin) {
    const tab = await activeTab(hub, clientId, signal);
    if (tab && originOf(tab.url) !== recipe.origin) {
      const first = recipe.steps[0];
      const firstUrl = first?.tool === 'navigate' ? first.args?.url : undefined;
      if (!firstUrl || originOf(firstUrl) !== recipe.origin) {
        return stop(
          runnerFailure({
            code: 'ORIGIN_MISMATCH',
            message: `This skill runs on ${recipe.origin}; the active tab is ${tab.url}.`,
            hint: `Open a tab on ${recipe.origin}, or start the recipe with its own navigate step.`,
          }),
        );
      }
    }
  }

  try {
    for (let index = 0; index < recipe.steps.length; index += 1) {
      if (signal?.aborted) return stop(cancelled());
      const step = recipe.steps[index];
      if (index < fromIndex) {
        skipped.push(step.id);
        continue;
      }
      const args = substitute(step.args ?? {}, params.params);
      const target = step.target ? substitute(step.target, params.params) : undefined;
      const callArgs = target ? { ...args, target } : { ...args };
      const label = describeStep({ ...step, args: callArgs, target });
      if (!quiet) await say(hub, clientId, `${skill.name} · ${index + 1}/${recipe.steps.length} · ${label}`, signal);

      if (dryRun) {
        const dry = await dryRunStep(hub, clientId, step, callArgs, target, signal);
        stepResults.push({ id: step.id, tool: step.tool, ok: dry.ok, text: dry.text, dryRun: true });
        if (!dry.ok) {
          return stop(
            runnerFailure({
              stepId: step.id,
              tool: step.tool,
              code: 'TARGET_NOT_FOUND',
              message: dry.text,
              hint: 'Take a snapshot to see the page as it is; the target may need a different role, name or nth.',
            }),
          );
        }
        continue;
      }

      const result = await hub.call(clientId, step.tool, callArgs, { signal });
      const ok = result?.ok !== false;
      stepResults.push({
        id: step.id,
        tool: step.tool,
        ok,
        text: ok ? String(result?.text ?? '') : String(result?.text ?? 'failed'),
      });
      if (!ok) {
        // The layer's own words: the code, whether input reached the page, and the hint. Nothing is re-worded here.
        const error = result?.error;
        const failure = {
          stepId: step.id,
          tool: step.tool,
          code: error?.code ?? 'STEP_FAILED',
          message: error?.message ?? String(result?.text ?? 'The step failed.'),
          hint:
            error?.hint ??
            'Nothing here says whether the action reached the page. Take a snapshot before trying again.',
          delivered: error?.delivered ?? 'unknown',
          text: String(result?.text ?? ''),
        };
        const action = resolveOnFail(recipe, step, failure.code);
        if (action === 'skip') {
          if (failure.delivered === false) {
            // Nothing reached the page, so skipping cannot carry a half-done effect forward.
            unskipped.push(step.id);
            continue;
          }
          failure.note =
            'The recipe says to skip this step, but something may have reached the page, so the run stopped.';
          return stop(failure);
        }
        return stop(failure, ACTION_OUTCOME[action] ?? 'failed');
      }
      const checks = await checkAssertions(hub, clientId, recipe, step.id, signal);
      if (!checks.ok) {
        assertionResults.push({ after: step.id, ok: false, text: checks.text });
        const failure = runnerFailure({
          stepId: step.id,
          tool: step.tool,
          code: checks.code,
          message: checks.text,
          hint: 'The step ran but the page does not show the result. Read the page before repeating anything: the write may have landed.',
          delivered: 'unknown',
        });
        // The check's own result is about the check, not about the step before it, so it is labelled: its "safe to
        // retry" must not be read as advice about the step that just ran.
        const checkSaid = checks.detail ? `The check's own result: ${short(checks.detail)}` : '';
        const failing = { ...failure, text: [failure.message, checkSaid, failure.hint].filter(Boolean).join('\n') };
        const action = resolveOnFail(recipe, step, failure.code);
        if (action === 'skip') {
          failing.note =
            'The recipe says to skip this step, but the check failed without saying whether the step worked, so the run stopped.';
          return stop(failing);
        }
        return stop(failing, ACTION_OUTCOME[action] ?? 'failed');
      }
      const sensitive = result?.receipt?.sensitive;
      if (sensitive && !(recipe.assert ?? []).some(item => item.after === step.id)) {
        unchecked.push({ step: step.id, kind: String(sensitive) });
      }
      for (const check of (recipe.assert ?? []).filter(item => item.after === step.id)) {
        assertionResults.push({
          after: step.id,
          ok: true,
          text: check.text ? `text «${check.text}»` : `url ${check.url}`,
        });
      }
      if (untilIndex >= 0 && index === untilIndex) {
        // Asked to stop here: the scene stays as it is, which is the point when debugging.
        for (const rest of recipe.steps.slice(untilIndex + 1)) skipped.push(rest.id);
        return {
          ok: true,
          text: summary(skill, stepResults, assertionResults, started, {
            unchecked,
            skipped,
            unskipped,
            notes,
            stoppedAt: step.id,
          }),
          data: {
            name: skill.name,
            outcome: 'stopped',
            dryRun,
            steps: stepResults,
            assertions: assertionResults,
            unchecked: unchecked.map(entry => entry.step),
            skipped,
            unskipped,
            stoppedAt: step.id,
            durationMs: Date.now() - started,
          },
        };
      }
      if (stepDelayMs > 0 && index < recipe.steps.length - 1) await sleep(stepDelayMs, signal);
    }
  } catch (error) {
    if (signal?.aborted) return stop(cancelled());
    return stop(
      runnerFailure({
        code: 'INTERNAL',
        message: `The skill stopped: ${error?.message ?? String(error)}`,
        hint: 'Look at the page before running the skill again.',
        delivered: 'unknown',
      }),
    );
  }

  return {
    ok: true,
    text: summary(skill, stepResults, assertionResults, started, { unchecked, skipped, unskipped, notes }),
    data: {
      name: skill.name,
      outcome: 'done',
      dryRun,
      steps: stepResults,
      assertions: assertionResults,
      unchecked: unchecked.map(entry => entry.step),
      skipped,
      unskipped,
      durationMs: Date.now() - started,
    },
  };
}

/** What one batch item is called in the report: its first text value, or its place in the list. */
function itemLabel(params, index) {
  for (const value of Object.values(params ?? {})) {
    if (typeof value === 'string' && value.trim() !== '') return short(value);
    if (typeof value === 'number') return String(value);
  }
  return `item ${index + 1}`;
}

/**
 * Runs one skill once per parameter set, in order, and reports the lot. The batch is the unit the user approves: the
 * first write asks, and "allow for this task" covers the rest (the extension holds that grant, not this runner).
 *
 * An item that fails does not stop the batch — that is what a batch is for — but a person being needed does: a decline,
 * a user step, or a card handed to someone. The report says which item stopped it.
 */
export async function runSkillBatch(hub, clientId, settings, skill, options = {}) {
  const items = Array.isArray(options.batch) ? options.batch : [];
  if (items.length === 0) throw new Error('A batch needs at least one set of params.');
  const started = Date.now();
  const done = [];
  let stopped;

  for (let index = 0; index < items.length; index += 1) {
    if (options.signal?.aborted) {
      stopped = 'the run was cancelled';
      break;
    }
    const params = items[index] && typeof items[index] === 'object' ? items[index] : {};
    const result = await runSkill(hub, clientId, settings, skill, { ...options, params, batch: undefined });
    const data = result.data ?? {};
    const code = data.failure?.code;
    done.push({
      index,
      label: itemLabel(params, index),
      params,
      ok: result.ok,
      outcome: data.outcome,
      failure: data.failure,
    });
    if (data.outcome === 'asked') {
      stopped = `${data.failure?.stepId ?? 'a step'} needs a person`;
      break;
    }
    if (code === 'USER_DECLINED') {
      stopped = 'the user declined';
      break;
    }
    if (code === 'USER_STEP') {
      stopped = 'a step is the user’s own';
      break;
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const failed = done.filter(entry => !entry.ok).length;
  const lines = [
    `Skill "${skill.name}" over ${done.length} of ${items.length} item${items.length === 1 ? '' : 's'} · ${done.length - failed} ok, ${failed} failed · ${seconds}s`,
  ];
  for (const entry of done) {
    const outcome = entry.ok ? (entry.outcome === 'reported' ? 'reported' : 'ok') : 'failed';
    const why = entry.failure
      ? ` · ${entry.failure.code}${entry.failure.stepId ? ` at ${entry.failure.stepId}` : ''}`
      : '';
    lines.push(`${entry.ok ? '✓' : '✗'} ${entry.label} · ${outcome}${why}`);
  }
  if (stopped) lines.push(`Stopped after ${done.length}: ${stopped}. ${items.length - done.length} not run.`);
  return {
    ok: failed === 0 && !stopped,
    text: lines.join('\n'),
    data: {
      name: skill.name,
      outcome: stopped ? 'stopped' : failed === 0 ? 'done' : 'failed',
      items: done.map(entry => ({
        index: entry.index,
        params: entry.params,
        ok: entry.ok,
        outcome: entry.outcome,
        ...(entry.failure ? { code: entry.failure.code, stepId: entry.failure.stepId } : {}),
      })),
      ran: done.length,
      requested: items.length,
      failed,
      ...(stopped ? { stopped } : {}),
      durationMs: Date.now() - started,
    },
  };
}
