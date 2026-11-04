// The external bridge client. A build made with WXT_BRIDGE set polls the local bridge that DSH starts, runs the layer's
// tools on the user's real Chrome tab, and posts each result back. The extension cannot listen for connections, so it
// connects out; the polling fetch also keeps the MV3 worker awake, with an alarm as the backstop.
//
// This is a developer surface, not part of the product: without the build flag nothing here runs.
import { isRestrictedUrl } from '@src/browser-control';
import type { Session } from '@src/browser-control';
import { browserPrompts } from './browser-prompts';
import { DebugRecorder } from './debug-recorder';
import { addPromptRoute, controllerReady } from './layer';

/** Labels defused wherever page text holds them: the model must not mistake a page for the host's own notes. */
const AGENT_LABELS = ['[Nanobrowser note', 'browser-state', 'agent-notes', 'custom-instructions'];

const ENABLED = !!import.meta.env.WXT_BRIDGE;
const PORT = Number(import.meta.env.WXT_BRIDGE_PORT ?? 8790);
const TOKEN = String(import.meta.env.WXT_BRIDGE_TOKEN ?? 'dev-token');
const BASE = `http://127.0.0.1:${PORT}`;
const ALARM = 'nb-external-bridge';
/** Longer than the bridge's 20 s poll timeout, so a normal empty poll arrives before this aborts. */
const POLL_TIMEOUT_MS = 30_000;
const RETRY_MS = 2_000;
/**
 * A card nobody answers is a decline after this long. It is deliberately shorter than the hub's call timeout (360 s by
 * default): the layer must answer the call, or decline it, before the caller gives up on the call itself.
 */
const CONFIRM_TIMEOUT_MS = 240_000;

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

/** What running one command needs from outside itself: the browser, the client's layer session and the side panel. */
export interface CommandPorts {
  sessionFor(clientId: string, options?: { shareVisible?: boolean }): Promise<Session>;
  /** The client's session, without creating one: a command that gives something back must not share a tab first. */
  sessionOf(clientId: string): Session | undefined;
  tabs: {
    query(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
    get(tabId: number): Promise<chrome.tabs.Tab>;
  };
  /** A URL the layer cannot drive, such as a browser page. */
  restricted(url: string): boolean;
  prompts(): ReturnType<typeof browserPrompts>;
  recorderFor(clientId: string, session: Session): CommandRecorder;
  /** Tabs a session took over without asking, reported once on the next result. */
  notices: Map<string, string>;
}

/** The recorder as the bridge uses it: the console and network trails a skill asserts on. */
export interface CommandRecorder {
  ensure(tabId: number): Promise<void>;
  readConsole(args: Record<string, unknown>): { text: string; entries: unknown[] };
  readNetwork(args: Record<string, unknown>): { text: string; requests: unknown[] };
}

/** The browser's own answers, for the worker: the test passes a fake in here instead. */
const defaultPorts: CommandPorts = {
  sessionFor: (clientId, options) => ensureSession(clientId, options),
  sessionOf: clientId => sessions.get(clientId),
  tabs: {
    query: query => chrome.tabs.query(query),
    get: tabId => chrome.tabs.get(tabId),
  },
  restricted: isRestrictedUrl,
  prompts: browserPrompts,
  recorderFor,
  notices: attachNotices,
};

/** The target a command names, for the panel's status line: the layer's own words are only known once it has run. */
function describeTarget(args: Record<string, unknown> | undefined): string {
  const name = typeof args?.name === 'string' ? args.name : '';
  return name ? ` «${name}»` : '';
}

/** Runs one command against the browser. Exported, with its ports, so a test can dispatch without a browser. */
export async function runCommand(
  command: Command,
  signal: AbortSignal,
  ports: CommandPorts = defaultPorts,
): Promise<unknown> {
  const clientId = String(command.clientId ?? 'default');
  try {
    if (command.tool === 'reload-extension') {
      return { ok: true, text: 'reloading the extension; the bridge connection returns in a few seconds' };
    }
    if (command.tool === 'say') {
      const text = String(command.args?.text ?? '').trim();
      if (!text) throw new Error('say needs some text.');
      ports.prompts()?.note(text);
      return { ok: true, text: 'shown in the side panel' };
    }
    // Handing a tab back: the session forgets it and the debugger goes, so the next client can take it cleanly. A
    // client with no session has nothing to give back, and asking for one here would share a tab just to drop it.
    if (command.tool === 'unshare') {
      const tabId = Number(command.args?.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('unshare needs a tabId.');
      const session = ports.sessionOf(clientId);
      if (!session) return { ok: true, text: `no session for this client; nothing to unshare` };
      await session.unshareTab(tabId).catch(() => undefined);
      return { ok: true, text: `unshared tab ${tabId}` };
    }
    // Every normal tab, for a new client that has no shared tab yet; the Hub leases one of them to this client.
    if (command.tool === 'tabs-all') {
      const data: Array<{ tabId: number; url: string; title: string; active: boolean }> = [];
      for (const tab of await ports.tabs.query({})) {
        if (tab.id === undefined || ports.restricted(tab.url ?? '')) continue;
        data.push({ tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '', active: tab.active === true });
      }
      const lines = data.map(
        tab =>
          `${tab.active ? '*' : ' '} tab ${tab.tabId} · «${tab.title.replace(/[«»]/g, '')}» · «${tab.url.replace(/[«»]/g, '')}»`,
      );
      return { ok: true, text: `tabs · ${data.length} in Chrome\n${lines.join('\n')}`, data: { tabs: data } };
    }
    const target = await ports.sessionFor(clientId, { shareVisible: command.tool !== 'attach' });
    // Add an exact tab to this client's layer session without going through its (possibly empty) tab list.
    if (command.tool === 'attach') {
      const tabId = Number(command.args?.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('attach needs a tabId.');
      const tab = await ports.tabs.get(tabId).catch(() => null);
      const id = tab?.id;
      if (id === undefined) throw new Error(`Tab ${tabId} is not available.`);
      if (ports.restricted(tab?.url ?? '')) throw new Error(`Tab ${tabId} is a browser page and cannot be driven.`);
      await target.share(id);
      await ports
        .recorderFor(clientId, target)
        .ensure(id)
        .catch(() => undefined);
      return { ok: true, text: `attached · tab ${tabId}` };
    }
    const notice = ports.notices.get(clientId) ?? null;
    ports.notices.delete(clientId);
    const tabId = target.activeTabId;
    // The panel says what the external session is doing on the tab, so the two windows agree.
    ports.prompts()?.working(true, tabId ?? undefined, `${command.tool}${describeTarget(command.args)}`);
    if (command.tool === 'console' || command.tool === 'network') {
      if (tabId === null) throw new Error('No shared tab: attach to a tab first.');
      const tab = await ports.tabs.get(tabId).catch(() => null);
      const recorder = ports.recorderFor(clientId, target);
      const read =
        command.tool === 'console'
          ? recorder.readConsole(command.args ?? {})
          : recorder.readNetwork(command.args ?? {});
      const text = `${command.tool} · tab ${tabId}${tab?.url ? ` · ${tab.url}` : ''}\n${read.text}`;
      // The entries travel with the text: a skill asserts on them instead of on lines of it.
      const data = 'entries' in read ? { entries: read.entries } : { entries: read.requests };
      return { ok: true, text: notice ? `${notice}\n${text}` : text, data };
    }
    const result = await target.call(command.tool, command.args ?? {}, { signal });
    const active = target.activeTabId;
    // The action stays on the panel afterwards, so the user can see what the agent did while they were looking away.
    ports.prompts()?.working(false, tabId ?? undefined, `${command.tool}${describeTarget(command.args)}`);
    if (active !== null)
      await ports
        .recorderFor(clientId, target)
        .ensure(active)
        .catch(() => undefined);
    return {
      ok: result.ok,
      text: notice ? `${notice}\n${result.text}` : result.text,
      error: result.error,
      // The receipt says whether the layer classified the action as a write, which the runner reports on.
      receipt: result.receipt,
      data: result.data,
    };
  } catch (error) {
    ports.prompts()?.working(false);
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

/** Where a client is, as the host needs it in its prompt: the tab it drove, after the command ran. */
interface TabIdentity {
  tabId: number;
  url: string;
  title: string;
}

/** The tab this client is on now, or null when it drives none. Reported with every result so the Hub can say so. */
async function tabOf(clientId: string): Promise<TabIdentity | null> {
  const tabId = sessions.get(clientId)?.activeTabId ?? null;
  if (tabId === null) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.id === undefined) return null;
  return { tabId: tab.id, url: tab.url ?? '', title: tab.title ?? '' };
}

/** Posts one result, with the tab the client is on after it: a navigation has already moved the tab by then. */
async function postResult(command: Command, result: unknown): Promise<void> {
  const tab = await tabOf(String(command.clientId ?? 'default'));
  await fetch(`${BASE}/result?token=${encodeURIComponent(TOKEN)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tab ? { id: command.id, result, tab } : { id: command.id, result }),
  });
}

/** What the command loop needs: how to run one command, where its result goes, and what follows a reload. */
export interface LoopPorts {
  run(command: Command, signal: AbortSignal): Promise<unknown>;
  post(command: Command, result: unknown): Promise<void>;
  reload(command: Command): void;
}

/**
 * The queue and the one-at-a-time discipline, apart from the browser: commands run in the order the bridge sent them, a
 * `cancel` aborts the call it names without waiting for it, and the poll loop keeps listening meanwhile. Exported so a
 * test can drive dispatch with a fake runner and a fake poster.
 */
export function createCommandLoop({ run, post, reload }: LoopPorts): {
  enqueue(commands: Command[]): void;
  drain(): Promise<void>;
} {
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
          await post(command, { ok: true, text: 'cancelled' });
          continue;
        }
        const controller = new AbortController();
        running.set(command.id, controller);
        try {
          const result = await run(command, controller.signal);
          await post(command, result);
        } finally {
          running.delete(command.id);
        }
        // A reload waits until its result is in, so the caller sees an answer instead of a lost connection.
        if (command.tool === 'reload-extension') reload(command);
      }
    } finally {
      draining = false;
    }
  }

  /** Adds commands to the queue. A cancel acts here, while the call it names is still inside `run`: the loop itself is
   * busy with that call and cannot reach the queue, so this is the one moment a cancellation can stop anything. */
  function enqueue(commands: Command[]): void {
    for (const command of commands) {
      if (command.tool === 'cancel') running.get(String(command.args?.id ?? ''))?.abort();
      pending.push(command);
    }
  }

  return { enqueue, drain };
}

const loop = createCommandLoop({
  run: (command, signal) => runCommand(command, signal),
  post: (command, result) => postResult(command, result),
  reload: () => setTimeout(() => chrome.runtime.reload(), 200),
});

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
        loop.enqueue(body.commands ?? []);
        void loop.drain();
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

/** Which client a tab belongs to, from the sessions this worker holds. */
function ownerOf(tabId: number): string | undefined {
  for (const [clientId, session] of sessions) if (session.hasTab(tabId)) return clientId;
  return undefined;
}

/** Tabs already reported as this client's: the hub binds twice for free, but the same event every keystroke is noise. */
const reported = new Set<number>();

async function postEvent(body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${BASE}/event?token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // The hub is not up, or went away: the next command will reconnect and the lease follows then.
  }
}

/**
 * What the page and the browser did on their own, so the hub's lease follows it: a tab a page opened joins its task,
 * a closed tab leaves. Without this the lease only changed when a command ran, and a task's tabs drifted from it.
 */
function watchTabs(): void {
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'complete' && info.url === undefined) return;
    const clientId = ownerOf(tabId);
    if (!clientId || reported.has(tabId)) return;
    reported.add(tabId);
    void postEvent({ type: 'tab', clientId, tabId });
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    const clientId = ownerOf(tabId);
    reported.delete(tabId);
    if (!clientId) return;
    void postEvent({ type: 'tab-closed', clientId, tabId });
  });
}

/** Starts the client; called once at worker start. */
export function startExternalBridge(): void {
  if (!ENABLED) return;
  ensurePolling();
  watchTabs();
  chrome.alarms?.create(ALARM, { periodInMinutes: 0.5 });
  chrome.alarms?.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) ensurePolling();
  });
}
