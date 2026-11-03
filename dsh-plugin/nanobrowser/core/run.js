// Run a Browser Skill through the hub.
//
// The recipe is deterministic: the model is not asked to re-decide each step. The layer still classifies writes and
// asks the user for approval; a failed step or assertion stops the run. The panel sees progress through `say` notes.

import { ACTION_TOOLS } from './tools.js';
import { describeStep } from './skills.js';

const MAX_TEXT = 240;

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

function resolveParams(recipe, provided) {
  const params = provided && typeof provided === 'object' ? { ...provided } : {};
  const missing = [];
  for (const [name, spec] of Object.entries(recipe.params ?? {})) {
    if (spec?.required !== false && params[name] === undefined) missing.push(name);
  }
  if (missing.length > 0) {
    return { ok: false, text: `Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` };
  }
  if (/\{\{secret:/.test(JSON.stringify(recipe))) {
    return {
      ok: false,
      text: 'This skill contains a secret parameter. Secret values are never stored or passed to the model; run that step yourself.',
    };
  }
  return { ok: true, params };
}

function validateRecipe(recipe, settings) {
  if (!recipe || typeof recipe !== 'object') throw new Error('The skill has no recipe.');
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) throw new Error('The skill has no steps.');
  if (recipe.steps.length > settings.maxSteps) {
    throw new Error(`The skill has ${recipe.steps.length} steps; the limit is ${settings.maxSteps}.`);
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

async function checkAssertions(hub, clientId, recipe, stepId, signal) {
  const checks = (recipe.assert ?? []).filter(check => check.after === stepId);
  for (const check of checks) {
    if (typeof check.text === 'string') {
      // `find` reads the latest observation; a check must read the live page, so use `wait`.
      const waited = await hub.call(clientId, 'wait', { text: check.text, ms: 2000 }, { signal });
      if (!waited || waited.ok === false) {
        return { ok: false, text: `After ${stepId}, the text «${check.text}» was not found.` };
      }
    } else if (typeof check.url === 'string') {
      const tab = await activeTab(hub, clientId, signal);
      if (!tab || !String(tab.url).includes(check.url)) {
        return { ok: false, text: `After ${stepId}, the URL did not contain ${check.url}.` };
      }
    }
  }
  return { ok: true };
}

function summary(skill, stepResults, assertionResults, started, failedStep) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const head = failedStep
    ? `Skill "${skill.name}" failed at step ${failedStep} · ${seconds}s`
    : `Ran skill "${skill.name}" · ${stepResults.length} step${stepResults.length === 1 ? '' : 's'} · ${seconds}s`;
  const lines = [head];
  for (const step of stepResults) {
    lines.push(`${step.ok ? '✓' : '✗'} ${step.id} · ${short(step.text)}`);
  }
  for (const check of assertionResults) {
    lines.push(`${check.ok ? '✓' : '✗'} check after ${check.after} · ${short(check.text)}`);
  }
  if (skill.recipe?.needsReview) {
    lines.push(
      'Note: some targets were recorded as refs because their role and name could not be resolved; review the recipe.',
    );
  }
  return lines.join('\n');
}

function fail(text, skill, stepResults, assertionResults, started, failedStep) {
  return {
    ok: false,
    text,
    data: {
      name: skill?.name,
      failedStep,
      steps: stepResults,
      assertions: assertionResults,
      durationMs: Date.now() - started,
    },
  };
}

/**
 * Runs one skill. Returns `{ok, text, data}`; a failed step or check is `ok: false`, not an exception, so the model
 * can read exactly where it stopped.
 */
export async function runSkill(hub, clientId, settings, skill, options = {}) {
  const started = Date.now();
  const stepResults = [];
  const assertionResults = [];
  let recipe;
  try {
    recipe = skill.recipe;
    validateRecipe(recipe, settings);
  } catch (error) {
    return fail(error.message, skill, stepResults, assertionResults, started);
  }
  const params = resolveParams(recipe, options.params);
  if (!params.ok) return fail(params.text, skill, stepResults, assertionResults, started);
  const signal = options.signal;
  const stepDelayMs = Math.max(0, Math.min(2000, Number(options.stepDelayMs ?? settings.stepDelayMs)));
  const dryRun = options.dryRun === true;
  const quiet = options.quiet === true;

  if (!hub.leaseOf(String(clientId))) {
    return fail('Attach this session to a tab first with nanobrowser_attach.', skill, stepResults, assertionResults, started);
  }

  if (recipe.origin) {
    const tab = await activeTab(hub, clientId, signal);
    if (tab && originOf(tab.url) !== recipe.origin) {
      const first = recipe.steps[0];
      const firstUrl = first?.tool === 'navigate' ? first.args?.url : undefined;
      if (!firstUrl || originOf(firstUrl) !== recipe.origin) {
        return fail(
          `This skill runs on ${recipe.origin}; the active tab is ${tab.url}. Open a tab on that site first.`,
          skill,
          stepResults,
          assertionResults,
          started,
        );
      }
    }
  }

  try {
    for (let index = 0; index < recipe.steps.length; index += 1) {
      if (signal?.aborted) return fail('The skill was cancelled.', skill, stepResults, assertionResults, started);
      const step = recipe.steps[index];
      const args = substitute(step.args ?? {}, params.params);
      const target = step.target ? substitute(step.target, params.params) : undefined;
      const callArgs = target ? { ...args, target } : { ...args };
      const label = describeStep({ ...step, args: callArgs, target });
      if (!quiet) await say(hub, clientId, `${skill.name} · ${index + 1}/${recipe.steps.length} · ${label}`, signal);

      if (dryRun) {
        const dry = await dryRunStep(hub, clientId, step, callArgs, target, signal);
        stepResults.push({ id: step.id, tool: step.tool, ok: dry.ok, text: dry.text, dryRun: true });
        if (!dry.ok)
          return fail(
            summary(skill, stepResults, assertionResults, started, step.id),
            skill,
            stepResults,
            assertionResults,
            started,
            step.id,
          );
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
        return fail(
          summary(skill, stepResults, assertionResults, started, step.id),
          skill,
          stepResults,
          assertionResults,
          started,
          step.id,
        );
      }
      const checks = await checkAssertions(hub, clientId, recipe, step.id, signal);
      if (!checks.ok) {
        assertionResults.push({ after: step.id, ok: false, text: checks.text });
        return fail(
          summary(skill, stepResults, assertionResults, started, step.id),
          skill,
          stepResults,
          assertionResults,
          started,
          step.id,
        );
      }
      for (const check of (recipe.assert ?? []).filter(item => item.after === step.id)) {
        assertionResults.push({
          after: step.id,
          ok: true,
          text: check.text ? `text «${check.text}»` : `url ${check.url}`,
        });
      }
      if (stepDelayMs > 0 && index < recipe.steps.length - 1) await sleep(stepDelayMs, signal);
    }
  } catch (error) {
    if (signal?.aborted) return fail('The skill was cancelled.', skill, stepResults, assertionResults, started);
    return fail(`The skill stopped: ${error?.message ?? String(error)}`, skill, stepResults, assertionResults, started);
  }

  return {
    ok: true,
    text: summary(skill, stepResults, assertionResults, started),
    data: {
      name: skill.name,
      dryRun,
      steps: stepResults,
      assertions: assertionResults,
      durationMs: Date.now() - started,
    },
  };
}
