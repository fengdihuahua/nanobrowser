// Turn one real browser run into a reusable recipe.
//
// The transcript is the source of truth: only calls that actually succeeded become steps. Refs are replaced by the
// role and name the layer resolved at action time, so the recipe survives a new document. Reads are dropped; waits
// stay because they are the run's own checks. A secret field is never recorded.

import { ACTION_TOOLS } from './tools.js';

const PREFIXES = ['nanobrowser_', 'mcp__nanobrowser__'];
const TARGETED_TOOLS = new Set(['click', 'set', 'type', 'hover', 'scroll']);
const SECRET_FIELD = /password|passcode|one[- ]?time|otp|verification|card|secret|pin/i;
const MAX_NOTES = 12;

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      if (block?.type === 'text') return block.text;
      if (block?.type === 'image') return '[image]';
      return block?.type ? `[${block.type}]` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function stripToolName(name) {
  const value = String(name ?? '');
  for (const prefix of PREFIXES) {
    if (value.startsWith(prefix)) {
      const raw = value.slice(prefix.length);
      return ACTION_TOOLS.has(raw) ? raw : undefined;
    }
  }
  return ACTION_TOOLS.has(value) ? value : undefined;
}

function isSuccess(resultEvent) {
  const message = resultEvent?.data?.message;
  if (!message || message.isError || resultEvent?.data?.error) return false;
  const text = contentText(message.content);
  if (/^error\b/im.test(text)) return false;
  if (/USER_STEP|USER_DECLINED|not dispatched|dispatch unknown|nothing was dispatched/i.test(text)) return false;
  return true;
}

function parseTarget(text) {
  const line = String(text ?? '').split('\n')[0] ?? '';
  const withRef = /\[(e\d+)\]\s+([a-z][a-z0-9-]*)\s+«([^»]*)»/i.exec(line);
  if (withRef && withRef[3]) return { role: withRef[2], name: withRef[3] };
  const named = /(?:^|·\s*)([a-z][a-z0-9-]*)\s+«([^»]*)»/i.exec(line);
  if (named && named[2]) return { role: named[1], name: named[2] };
  return undefined;
}

function targetFromArgs(target) {
  if (!target || typeof target !== 'object') return undefined;
  const copy = {};
  if (typeof target.role === 'string') copy.role = target.role;
  if (typeof target.name === 'string') copy.name = target.name;
  if (Number.isInteger(target.nth)) copy.nth = target.nth;
  // A ref, and a `within` (which is a ref), belong to the document they were seen in. They never reach a recipe; the
  // step keeps role and name, and is flagged for review when that is not enough.
  if (typeof target.ref === 'string' || typeof target.within === 'string') copy.needsReview = true;
  if (copy.name === undefined) return undefined;
  return copy;
}

/** A parameter name from a field's accessible name, when that name is words rather than a label in another script. */
function inferParamName(label) {
  const words = String(label ?? '')
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return undefined;
  const camel =
    words[0].toLowerCase() +
    words
      .slice(1)
      .map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
      .join('');
  return /^[a-z][a-zA-Z0-9]{0,31}$/.test(camel) ? camel : undefined;
}

function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function buildStep(tool, args, target) {
  const step = { tool, args: {} };
  switch (tool) {
    case 'navigate':
      step.args = pick(args, ['url', 'action']);
      break;
    case 'click':
      if (!target) return undefined;
      step.args = pick(args, ['button', 'count', 'modifiers']);
      break;
    case 'set':
      if (!target || args.value === undefined) return undefined;
      step.args = { value: args.value, ...(args.submit === true ? { submit: true } : {}) };
      break;
    case 'type':
      if (args.text === undefined) return undefined;
      step.args = { text: args.text, ...(args.submit === true ? { submit: true } : {}) };
      break;
    case 'press':
      if (typeof args.keys !== 'string' || !args.keys) return undefined;
      step.args = { keys: args.keys };
      break;
    case 'hover':
      if (!target) return undefined;
      break;
    case 'scroll': {
      step.args = pick(args, ['to', 'by']);
      if (step.args.to && typeof step.args.to === 'object') delete step.args.to;
      break;
    }
    case 'wait':
      step.args = pick(args, ['text', 'textGone', 'state', 'url', 'ms']);
      if (Object.keys(step.args).length === 0) return undefined;
      break;
    case 'handle_dialog':
      if (typeof args.accept !== 'boolean') return undefined;
      step.args = {
        accept: args.accept,
        ...(typeof args.promptText === 'string' ? { promptText: args.promptText } : {}),
      };
      break;
    default:
      return undefined;
  }
  if (target) {
    step.target = { ...target };
    delete step.target.needsReview;
    if (target.needsReview) step.needsReview = true;
  }
  return step;
}

function replaceExact(value, params) {
  if (typeof value === 'string') {
    for (const [name, literal] of Object.entries(params)) {
      if (value === String(literal)) return `{{${name}}}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => replaceExact(item, params));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = replaceExact(item, params);
    return out;
  }
  return value;
}

function paramDefinitions(params) {
  const out = {};
  for (const [name, literal] of Object.entries(params)) {
    const type = typeof literal === 'number' ? 'number' : typeof literal === 'boolean' ? 'boolean' : 'string';
    out[name] = { type, required: true };
  }
  return out;
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function groupTurns(events) {
  const turns = new Map();
  for (const event of events) {
    if (event?.type === 'tool/call') {
      const turn = event.data?.turn;
      if (turn === undefined) continue;
      if (!turns.has(turn)) turns.set(turn, { calls: [], results: new Map() });
      turns.get(turn).calls.push(event);
    } else if (event?.type === 'tool/result') {
      const turn = event.data?.turn;
      if (turn === undefined) continue;
      if (!turns.has(turn)) turns.set(turn, { calls: [], results: new Map() });
      // ToolResultMessage carries the call identity as `toolCallId` (and on its source), not `callId`.
      const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId ?? event.data?.callId;
      if (callId !== undefined) turns.get(turn).results.set(String(callId), event);
    }
  }
  return turns;
}

function turnHasAction(turn) {
  return turn.calls.some(call => stripToolName(call.data?.name) !== undefined);
}

function turnHasSuccessfulAction(turn) {
  return turn.calls.some(call => {
    if (stripToolName(call.data?.name) === undefined) return false;
    const result = turn.results.get(String(call.data?.callId ?? ''));
    return result !== undefined && isSuccess(result);
  });
}

/**
 * Capture one turn. `params` maps a parameter name to the literal recorded in that run; every exact match becomes
 * `{{name}}`. `activeOrigin` is used only when the turn did not navigate.
 */
export function captureTurn(session, options = {}) {
  const events = session?.snapshotEvents?.() ?? [];
  const turns = groupTurns(events);
  const requested = options.turn;
  let turnNumber;
  let selected;
  if (requested !== undefined) {
    turnNumber = Number(requested);
    selected = turns.get(turnNumber);
    if (!selected) throw new Error(`Turn ${turnNumber} has no tool calls in this session.`);
    if (!turnHasAction(selected)) throw new Error(`Turn ${turnNumber} has no browser actions.`);
  } else {
    const numbers = [...turns.keys()].sort((a, b) => b - a);
    turnNumber = numbers.find(number => turnHasSuccessfulAction(turns.get(number)));
    if (turnNumber === undefined) {
      throw new Error(
        'No turn with a successful browser action was found. Perform the task once, then save it as a skill.',
      );
    }
    selected = turns.get(turnNumber);
  }

  const params = options.params && typeof options.params === 'object' ? options.params : {};
  const steps = [];
  const notes = [];
  let origin;
  let needsReview = false;

  for (const call of selected.calls) {
    const tool = stripToolName(call.data?.name);
    if (!tool) continue;
    const result = selected.results.get(String(call.data?.callId ?? ''));
    if (!result) {
      notes.push(`Skipped ${tool}: no result was recorded.`);
      continue;
    }
    if (!isSuccess(result)) {
      const text = contentText(result.data?.message?.content).split('\n')[0] ?? 'it failed';
      notes.push(`Skipped ${tool}: ${text}`);
      continue;
    }
    let args;
    try {
      args = JSON.parse(call.data?.arguments || '{}');
    } catch {
      notes.push(`Skipped ${tool}: its arguments were not JSON.`);
      continue;
    }
    const resultText = contentText(result.data?.message?.content);
    const fromResult = TARGETED_TOOLS.has(tool) ? parseTarget(resultText) : undefined;
    const scrollTarget = tool === 'scroll' && args.to && typeof args.to === 'object' ? args.to : undefined;
    const target = fromResult ?? targetFromArgs(args.target ?? scrollTarget);
    if (TARGETED_TOOLS.has(tool) && tool !== 'type' && tool !== 'scroll' && !target) {
      notes.push(`Skipped ${tool}: its target could not be resolved.`);
      continue;
    }
    const label = String(target?.name ?? args.target?.name ?? scrollTarget?.name ?? '');
    if ((tool === 'set' || tool === 'type') && SECRET_FIELD.test(label)) {
      notes.push(`Skipped ${tool} on a secret field «${label}».`);
      continue;
    }
    const step = buildStep(tool, args, target);
    if (!step) {
      notes.push(`Skipped ${tool}: it had no usable arguments.`);
      continue;
    }
    step.id = `s${steps.length + 1}`;
    step.args = replaceExact(step.args, params);
    if (step.target) step.target = replaceExact(step.target, params);
    if (step.needsReview) needsReview = true;
    steps.push(step);
    if (tool === 'navigate' && typeof args.url === 'string') origin = origin ?? safeOrigin(args.url);
  }

  if (steps.length === 0) {
    throw new Error(`No browser actions were captured. ${notes.join(' ')}`.trim());
  }
  const limit = Number(options.maxSteps);
  if (Number.isFinite(limit) && limit > 0 && steps.length > limit) {
    throw new Error(
      `This run has ${steps.length} actions and the limit is ${limit}. Split it into two skills, or record the last ${limit} with last: ${limit}.`,
    );
  }

  // A field's own name is the parameter name a person would have chosen: «Order number» filed with Q-1001 becomes
  // params.orderNumber, and the step keeps {{orderNumber}}. Only when the caller named no params of its own, and only
  // for names that are words — a label in another script would not survive placeholder substitution.
  if (Object.keys(params).length === 0) {
    const inferred = {};
    for (const step of steps) {
      if (step.tool !== 'set' && step.tool !== 'type') continue;
      const value = step.tool === 'set' ? step.args?.value : step.args?.text;
      if (typeof value !== 'string' || value.trim() === '') continue;
      const name = inferParamName(step.target?.name);
      if (!name || inferred[name] !== undefined) continue;
      inferred[name] = value;
    }
    if (Object.keys(inferred).length > 0) {
      for (const step of steps) {
        for (const [name, value] of Object.entries(inferred)) {
          if (step.tool === 'set' && step.args?.value === value) step.args.value = `{{${name}}}`;
          if (step.tool === 'type' && step.args?.text === value) step.args.text = `{{${name}}}`;
        }
      }
      Object.assign(params, inferred);
      notes.push(`Inferred params from the fields: ${Object.keys(inferred).join(', ')}.`);
    }
  }

  // A retry or a correction often leaves two navigations in a row; only the last one describes the run.
  let capturedSteps = steps;
  const last = Number(options.last);
  if (Number.isInteger(last) && last > 0 && steps.length > last) capturedSteps = steps.slice(-last);

  const collapsed = [];
  for (const step of capturedSteps) {
    if (step.tool === 'navigate' && collapsed.length > 0 && collapsed[collapsed.length - 1].tool === 'navigate') {
      collapsed[collapsed.length - 1] = step;
    } else {
      collapsed.push(step);
    }
  }
  collapsed.forEach((step, index) => {
    step.id = `s${index + 1}`;
  });

  // A fixed wait is a bet on how long the page needs. When the next step names a target, the wait can say what it was
  // waiting for instead — the thing it is about to act on — which holds on a slow page and does not cost time on a
  // fast one. A fixed wait nothing follows stays as it is, and is called out.
  let fixedWaits = 0;
  for (let index = 0; index < collapsed.length; index += 1) {
    const step = collapsed[index];
    if (step.tool !== 'wait' || step.args?.ms === undefined) continue;
    if (step.args.text !== undefined || step.args.url !== undefined || step.args.state !== undefined) continue;
    const next = collapsed[index + 1];
    if (next?.target) {
      step.args = { state: 'visible' };
      step.target = { ...next.target };
      continue;
    }
    fixedWaits += 1;
    notes.push(`Step ${step.id} waits a fixed ${step.args.ms} ms; it cannot tell whether the page was ready.`);
  }
  const asserts = [];
  for (const step of collapsed) {
    if (step.tool !== 'wait') continue;
    if (typeof step.args?.text === 'string') asserts.push({ after: step.id, text: step.args.text });
    else if (typeof step.args?.url === 'string') asserts.push({ after: step.id, url: step.args.url });
  }

  return {
    turn: turnNumber,
    steps: collapsed,
    assert: asserts,
    origin: origin ?? options.activeOrigin,
    params: paramDefinitions(params),
    notes: notes.slice(0, MAX_NOTES),
    needsReview,
  };
}
