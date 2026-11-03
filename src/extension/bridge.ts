// The external bridge client. A build made with WXT_BRIDGE set polls the local bridge that DSH starts, runs the layer's
// tools on the user's real Chrome tab, and posts each result back. The extension cannot listen for connections, so it
// connects out; the polling fetch also keeps the MV3 worker awake, with an alarm as the backstop.
//
// This is a developer surface, not part of the product: without the build flag nothing here runs.
import { isRestrictedUrl } from '@src/browser-control';
import type { Session } from '@src/browser-control';
import { AGENT_LABELS } from './agent-session';
import { browserPrompts } from './browser-prompts';
import { DebugRecorder } from './debug-recorder';
import { addPromptRoute, controllerReady } from './layer';

const ENABLED = !!import.meta.env.WXT_BRIDGE;
const PORT = Number(import.meta.env.WXT_BRIDGE_PORT ?? 8790);
const TOKEN = String(import.meta.env.WXT_BRIDGE_TOKEN ?? 'dev-token');
const BASE = `http://127.0.0.1:${PORT}`;
const ALARM = 'nb-external-bridge';
/** Longer than the bridge's 20 s poll timeout, so a normal empty poll arrives before this aborts. */
const POLL_TIMEOUT_MS = 30_000;
const RETRY_MS = 2_000;
/** A card nobody answers is a decline after this long; the bridge's own tool timeout is longer. */
const CONFIRM_TIMEOUT_MS = 300_000;

interface Command {
  id: string;
  /** The calling client (a DSH session or an MCP adapter); one layer session per client. */
  clientId?: string;
  tool: string;
  args?: Record<string, unknown>;
}

/** One layer session per external client, so two agents can drive two tabs without sharing refs. */
const sessions = new Map<string, Session>();
const recorders = new Map<string, DebugRecorder>();
let polling = false;
/** A warning per client, reported once in the result that picked another tab. */
const attachNotices = new Map<string, string>();
let promptRouteInstalled = false;

function recorderFor(clientId: string, target: Session): DebugRecorder {
  let recorder = recorders.get(clientId);
  if (!recorder) {
    recorder = new DebugRecorder(target.controller);
    recorders.set(clientId, recorder);
  }
  return recorder;
}

/** Give a session the visible page, or the most recently used normal page when the visible one is a browser page. */
async function shareVisibleTab(target: Session): Promise<string | null> {
  const [visible] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const usable = (tab: chrome.tabs.Tab) => !!tab.id && !isRestrictedUrl(tab.url ?? '');
  let tab = visible && usable(visible) ? visible : undefined;
  let notice: string | null = null;
  if (!tab) {
    // The user is looking at a browser page (chrome://extensions, the new tab page, and so on). A page is still
    // wanted, so take the most recent one the debugger can attach to instead of refusing, and say so.
    tab = (await chrome.tabs.query({ lastFocusedWindow: true }))
      .filter(usable)
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (tab?.id !== undefined) {
      notice = `The visible tab was a browser page (${visible?.url ?? 'none'}); the session drives tab ${tab.id} «${tab.url ?? ''}» instead.`;
    }
  }
  if (!tab?.id) throw new Error('No normal page is open in Chrome: open one first.');
  await target.share(tab.id);
  return notice;
}

/**
 * One layer session per client. The first client adopts the visible tab, preserving the single-client flow; later
 * clients start with no tab and receive one through `attach` or `tabs open`, which the Hub leases separately.
 */
async function ensureSession(clientId: string, options: { shareVisible?: boolean } = {}): Promise<Session> {
  const existing = sessions.get(clientId);
  if (existing) {
    const shared = existing.activeTabId;
    if (shared !== null)
      await recorderFor(clientId, existing)
        .ensure(shared)
        .catch(() => undefined);
    return existing;
  }
  const controller = await controllerReady;
  const created = controller.createSession({
    // The external agent gets the layer's core tools and nothing else: no page script, no devtools, no files.
    capabilities: [],
    // A submit, send, delete or upload raises a card in the side panel; a payment, an access grant, a secret field
    // and a page's prompt dialog are the user's own step and are refused with USER_STEP.
    handover: true,
    confirmTimeoutMs: CONFIRM_TIMEOUT_MS,
    askTimeoutMs: 120_000,
    decideWrite: question => browserPrompts()?.decideWrite(question) ?? { decision: 'ask', canRemember: false },
    boundary: { labels: AGENT_LABELS },
  });
  sessions.set(clientId, created);
  if (!promptRouteInstalled) {
    promptRouteInstalled = true;
    const store = browserPrompts();
    if (store) {
      // This route goes first: while DSH drives a tab, its cards are DSH's, even if a conversation also holds the tab.
      addPromptRoute(
        {
          owns: tabId => [...sessions.values()].some(candidate => candidate.hasTab(tabId)),
          prompt: store.userPrompt(),
        },
        { first: true },
      );
    }
  }
  if (options.shareVisible !== false && sessions.size === 1) {
    const notice = await shareVisibleTab(created);
    if (notice) attachNotices.set(clientId, notice);
    const shared = created.activeTabId;
    if (shared !== null)
      await recorderFor(clientId, created)
        .ensure(shared)
        .catch(() => undefined);
  }
  return created;
}

/** The target a command names, for the panel's status line: the layer's own words are only known once it has run. */
function describeTarget(args: Record<string, unknown> | undefined): string {
  const name = typeof args?.name === 'string' ? args.name : '';
  return name ? ` «${name}»` : '';
}

async function run(command: Command, signal: AbortSignal): Promise<unknown> {
  const clientId = String(command.clientId ?? 'default');
  try {
    if (command.tool === 'reload-extension') {
      return { ok: true, text: 'reloading the extension; the bridge connection returns in a few seconds' };
    }
    if (command.tool === 'say') {
      const text = String(command.args?.text ?? '').trim();
      if (!text) throw new Error('say needs some text.');
      browserPrompts()?.note(text);
      return { ok: true, text: 'shown in the side panel' };
    }
    // Every normal tab, for a new client that has no shared tab yet; the Hub leases one of them to this client.
    if (command.tool === 'tabs-all') {
      const data: Array<{ tabId: number; url: string; title: string; active: boolean }> = [];
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id === undefined || isRestrictedUrl(tab.url ?? '')) continue;
        data.push({ tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '', active: tab.active === true });
      }
      const lines = data.map(
        tab =>
          `${tab.active ? '*' : ' '} tab ${tab.tabId} · «${tab.title.replace(/[«»]/g, '')}» · «${tab.url.replace(/[«»]/g, '')}»`,
      );
      return { ok: true, text: `tabs · ${data.length} in Chrome\n${lines.join('\n')}`, data: { tabs: data } };
    }
    const target = await ensureSession(clientId, { shareVisible: command.tool !== 'attach' });
    // Add an exact tab to this client's layer session without going through its (possibly empty) tab list.
    if (command.tool === 'attach') {
      const tabId = Number(command.args?.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('attach needs a tabId.');
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const id = tab?.id;
      if (id === undefined) throw new Error(`Tab ${tabId} is not available.`);
      if (isRestrictedUrl(tab?.url ?? '')) throw new Error(`Tab ${tabId} is a browser page and cannot be driven.`);
      await target.share(id);
      await recorderFor(clientId, target)
        .ensure(id)
        .catch(() => undefined);
      return { ok: true, text: `attached · tab ${tabId}` };
    }
    const notice = attachNotices.get(clientId) ?? null;
    attachNotices.delete(clientId);
    const tabId = target.activeTabId;
    // The panel says what the external session is doing on the tab, so the two windows agree.
    browserPrompts()?.working(true, tabId ?? undefined, `${command.tool}${describeTarget(command.args)}`);
    if (command.tool === 'console' || command.tool === 'network') {
      if (tabId === null) throw new Error('No shared tab: attach to a tab first.');
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const body =
        command.tool === 'console'
          ? recorderFor(clientId, target).readConsole(command.args ?? {})
          : recorderFor(clientId, target).readNetwork(command.args ?? {});
      const text = `${command.tool} · tab ${tabId}${tab?.url ? ` · ${tab.url}` : ''}\n${body}`;
      return { ok: true, text: notice ? `${notice}\n${text}` : text };
    }
    const result = await target.call(command.tool, command.args ?? {}, { signal });
    const active = target.activeTabId;
    // The action stays on the panel afterwards, so the user can see what the agent did while they were looking away.
    browserPrompts()?.working(false, tabId ?? undefined, `${command.tool}${describeTarget(command.args)}`);
    if (active !== null)
      await recorderFor(clientId, target)
        .ensure(active)
        .catch(() => undefined);
    return {
      ok: result.ok,
      text: notice ? `${notice}\n${result.text}` : result.text,
      error: result.error,
      data: result.data,
    };
  } catch (error) {
    browserPrompts()?.working(false);
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

async function postResult(id: string, result: unknown): Promise<void> {
  await fetch(`${BASE}/result?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, result }),
  });
}

/** Commands from the bridge, run one at a time; the poll loop keeps listening so a cancel can arrive meanwhile. */
const pending: Command[] = [];
const running = new Map<string, AbortController>();
let draining = false;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let command = pending.shift(); command; command = pending.shift()) {
      if (command.tool === 'cancel') {
        running.get(String(command.args?.id ?? ''))?.abort();
        await postResult(command.id, { ok: true, text: 'cancelled' });
        continue;
      }
      const controller = new AbortController();
      running.set(command.id, controller);
      try {
        await postResult(command.id, await run(command, controller.signal));
      } finally {
        running.delete(command.id);
      }
      // Reload only after the result is in, so the caller sees an answer instead of a lost connection.
      if (command.tool === 'reload-extension') setTimeout(() => chrome.runtime.reload(), 200);
    }
  } finally {
    draining = false;
  }
}

/** Polls until the worker ends. A bridge that is not up yet is retried, never fatal. */
async function pollLoop(): Promise<void> {
  polling = true;
  try {
    for (;;) {
      try {
        const response = await fetch(`${BASE}/poll?token=${encodeURIComponent(TOKEN)}`, {
          signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`the bridge answered ${response.status}`);
        const body = (await response.json()) as { commands?: Command[] };
        for (const command of body.commands ?? []) pending.push(command);
        void drain();
      } catch {
        await new Promise(resolve => setTimeout(resolve, RETRY_MS));
      }
    }
  } finally {
    polling = false;
  }
}

function ensurePolling(): void {
  if (!ENABLED || polling) return;
  void pollLoop().catch(error => console.error('[bridge] poll failed', error));
}

/** Starts the client; called once at worker start. */
export function startExternalBridge(): void {
  if (!ENABLED) return;
  ensurePolling();
  chrome.alarms?.create(ALARM, { periodInMinutes: 0.5 });
  chrome.alarms?.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) ensurePolling();
  });
}
