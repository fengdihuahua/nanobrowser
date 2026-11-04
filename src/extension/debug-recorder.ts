// Console and network capture for the external session: read-only CDP observation of the tab it shares.
// It is not part of the deterministic layer; it buffers what the page and the browser report, for the developer to read.
import type { CdpPort, Controller, TabAttachment } from '@src/browser-control';

interface ConsoleArg {
  type?: string;
  value?: unknown;
  description?: string;
  preview?: { properties?: Array<{ name: string; value?: string }> };
}

interface ConsoleEvent {
  type?: string;
  args?: ConsoleArg[];
  stackTrace?: { callFrames?: Array<{ url?: string }> };
}

interface LogEvent {
  entry?: { source?: string; level?: string; text?: string; url?: string };
}

interface ExceptionEvent {
  exceptionDetails?: {
    text?: string;
    url?: string;
    lineNumber?: number;
    exception?: { description?: string };
  };
}

interface RequestEvent {
  requestId?: string;
  request?: { url?: string; method?: string };
  type?: string;
}

interface ResponseEvent {
  requestId?: string;
  response?: { url?: string; status?: number };
  type?: string;
}

interface FailedEvent {
  requestId?: string;
  errorText?: string;
  canceled?: boolean;
}

interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
}

interface NetworkEntry {
  method: string;
  url: string;
  type?: string;
  status?: number;
  failed?: string;
}

const MAX_MESSAGES = 500;
const MAX_REQUESTS = 500;
const MAX_TEXT = 1000;

function textOf(arg: ConsoleArg): string {
  if (arg.value !== undefined && arg.value !== null) return String(arg.value);
  // A preview's properties say more than the word "Object" that the description holds for a plain object.
  const properties = arg.preview?.properties;
  if (properties?.length) return `{ ${properties.map(p => `${p.name}: ${p.value ?? ''}`).join(', ')} }`;
  if (typeof arg.description === 'string') return arg.description;
  return arg.type ?? 'object';
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

/**
 * Captures the tab's console messages and network requests while the external session is attached. The domains are
 * enabled on the tab's root session: iframe content is not included in this version.
 */
export class DebugRecorder {
  #controller: Controller;
  #tabId: number | null = null;
  #attachment: TabAttachment | null = null;
  #disposers: Array<() => void> = [];
  #messages: ConsoleEntry[] = [];
  #requests = new Map<string, NetworkEntry>();
  #order: string[] = [];

  constructor(controller: Controller) {
    this.#controller = controller;
  }

  /** Attaches the tab (if needed) and starts buffering. Idempotent for the same tab and attachment. */
  async ensure(tabId: number): Promise<void> {
    if (this.#tabId === tabId && this.#attachment && !this.#attachment.detached) return;
    const sameTab = this.#tabId === tabId;
    this.stop();
    if (!sameTab) this.#reset();
    const attachment = await this.#controller.attach(tabId);
    this.#tabId = tabId;
    this.#attachment = attachment;
    const cdp: CdpPort = attachment.cdp;
    const only = { sessionId: undefined };
    this.#disposers = [
      cdp.on('Runtime.consoleAPICalled', params => this.#consoleEvent(params), only),
      cdp.on('Runtime.exceptionThrown', params => this.#exceptionEvent(params), only),
      cdp.on('Log.entryAdded', params => this.#logEvent(params), only),
      cdp.on('Network.requestWillBeSent', params => this.#requestEvent(params), only),
      cdp.on('Network.responseReceived', params => this.#responseEvent(params), only),
      cdp.on('Network.loadingFailed', params => this.#failedEvent(params), only),
      attachment.onDetach(() => this.stop()),
    ];
    await Promise.all([
      cdp.send(undefined, 'Runtime.enable').catch(() => undefined),
      cdp.send(undefined, 'Log.enable').catch(() => undefined),
      cdp.send(undefined, 'Network.enable').catch(() => undefined),
    ]);
  }

  stop(): void {
    for (const dispose of this.#disposers) dispose();
    this.#disposers = [];
    this.#attachment = null;
  }

  /** The captured console messages, newest last, optionally filtered and cleared. */
  /** The captured console messages, as the lines the panel shows and as entries a skill can assert on. */
  readConsole(args: Record<string, unknown>): { text: string; entries: ConsoleEntry[] } {
    const level = typeof args.level === 'string' ? args.level.toLowerCase() : 'all';
    const limit = bounded(args.limit, 50, 1, 200);
    const matching = this.#messages.filter(m => level === 'all' || m.level.toLowerCase() === level);
    const entries = matching.slice(-limit);
    if (args.clear === true) this.#messages = [];
    const lines = entries.map(m => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ''}`);
    return {
      text: lines.length ? lines.join('\n') : `(no console messages${level === 'all' ? '' : ` at ${level}`})`,
      entries,
    };
  }

  /** The captured network requests, in request order, optionally filtered and cleared. */
  readNetwork(args: Record<string, unknown>): { text: string; requests: NetworkEntry[] } {
    const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : '';
    const failedOnly = args.failedOnly === true;
    const limit = bounded(args.limit, 50, 1, 200);
    const matching = [...this.#requests.values()].filter(
      e => (!filter || e.url.toLowerCase().includes(filter)) && (!failedOnly || !!e.failed),
    );
    const requests = matching.slice(-limit);
    if (args.clear === true) {
      this.#requests.clear();
      this.#order = [];
    }
    const lines = requests.map(e => {
      const status = e.failed ? `FAILED ${e.failed}` : (e.status ?? 'pending');
      return `${status} ${e.method} ${e.url}${e.type ? ` (${e.type})` : ''}`;
    });
    return { text: lines.length ? lines.join('\n') : '(no network requests)', requests };
  }

  #reset(): void {
    this.#messages = [];
    this.#requests.clear();
    this.#order = [];
  }

  #push(entry: ConsoleEntry): void {
    this.#messages.push({ ...entry, text: entry.text.slice(0, MAX_TEXT) });
    while (this.#messages.length > MAX_MESSAGES) this.#messages.shift();
  }

  #consoleEvent(raw: unknown): void {
    const event = raw as ConsoleEvent;
    const text = (event.args ?? []).map(textOf).join(' ');
    if (!text) return;
    this.#push({ level: event.type ?? 'log', text, url: event.stackTrace?.callFrames?.[0]?.url });
  }

  /** An uncaught error reaches the page's console through the exception channel, not as a console call. */
  #exceptionEvent(raw: unknown): void {
    const details = (raw as ExceptionEvent).exceptionDetails;
    if (!details) return;
    const text = details.exception?.description ?? details.text;
    if (!text) return;
    // The description usually names the location already; only add it when it does not.
    const line = (details.lineNumber ?? 0) + 1;
    const where = details.url && !text.includes(details.url) ? `${details.url}:${line}` : undefined;
    this.#push({ level: 'error', text, url: where });
  }

  #logEvent(raw: unknown): void {
    const entry = (raw as LogEvent).entry;
    if (!entry?.text) return;
    this.#push({
      level: entry.level ?? 'info',
      text: `[${entry.source ?? 'browser'}] ${entry.text}`,
      url: entry.url,
    });
  }

  #requestEvent(raw: unknown): void {
    const event = raw as RequestEvent;
    const id = event.requestId;
    if (!id) return;
    const existing = this.#requests.get(id);
    if (existing) {
      existing.url = event.request?.url || existing.url;
      existing.method = event.request?.method ?? existing.method;
      existing.type = event.type ?? existing.type;
      return;
    }
    this.#requests.set(id, { method: event.request?.method ?? 'GET', url: event.request?.url ?? '', type: event.type });
    this.#order.push(id);
    while (this.#order.length > MAX_REQUESTS) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) this.#requests.delete(oldest);
    }
  }

  #responseEvent(raw: unknown): void {
    const event = raw as ResponseEvent;
    const id = event.requestId;
    if (!id) return;
    const existing = this.#requests.get(id);
    if (existing) {
      existing.status = event.response?.status;
      existing.type = event.type ?? existing.type;
      return;
    }
    if (!event.response?.url) return;
    // A request that started before the domains were enabled; keep its response.
    this.#requests.set(id, {
      method: '?',
      url: event.response.url,
      type: event.type,
      status: event.response.status,
    });
    this.#order.push(id);
    while (this.#order.length > MAX_REQUESTS) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) this.#requests.delete(oldest);
    }
  }

  #failedEvent(raw: unknown): void {
    const event = raw as FailedEvent;
    const id = event.requestId;
    if (!id) return;
    const existing = this.#requests.get(id);
    if (existing) existing.failed = event.canceled ? 'canceled' : (event.errorText ?? 'failed');
  }
}
