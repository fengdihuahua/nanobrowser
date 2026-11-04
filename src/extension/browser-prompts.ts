// Cards for the external browser session: the layer's confirmations for tabs the DSH-side session drives. There is no
// conversation behind them, so they go to every open side panel and are answered from there. A card with no panel open
// waits until the layer's clock runs out, and the answer is then a decline, so nothing is dispatched unseen.
import { siteOf } from '@src/browser-control';
import type {
  AskAnswer,
  AskRequest,
  ConfirmAnswer,
  ConfirmRequest,
  UserPrompt,
  WriteDecision,
  WriteQuestion,
} from '@src/browser-control';
import type { OpenPrompt, PanelEventBody } from '@src/ui/protocol';

/** How long a task's write grant lasts if nothing ends it sooner. A backstop, not the intended way out. */
const TASK_GRANT_MS = 30 * 60_000;

interface Waiting {
  prompt: OpenPrompt;
  resolve: (answer: unknown) => void;
}

export interface BrowserPromptsHooks {
  /** Sends an event to every open panel, whichever conversation it shows. */
  emit(body: PanelEventBody): void;
  /** The tab's address, read by the extension (never from page text). */
  tabUrl(tabId: number): Promise<string>;
  /** "Always allow on this site" was chosen on a card. */
  remember(site: string): Promise<void>;
  /** The host's write policy for the external session: Ask unless the site is set to Allow. */
  decideWrite(question: WriteQuestion): WriteDecision;
}

export class BrowserPrompts {
  #open = new Map<string, Waiting>();
  /**
   * Tabs whose classified writes the user allowed for the rest of the task, from a card's "allow this task". In memory
   * only: a detach, a worker restart or the cap below ends it, and it never becomes a site rule.
   */
  #taskGrants = new Map<number, number>();
  /** The last status line, kept so a panel that connects later still shows it. */
  #state: { active: boolean; tabId?: number; lastAction?: string } | null = null;

  constructor(readonly hooks: BrowserPromptsHooks) {}

  /** The cards open now, for a panel that has just connected. */
  prompts(): OpenPrompt[] {
    return [...this.#open.values()].map(w => w.prompt);
  }

  /** Opens a card and waits for its answer, or resolves 'withdrawn' when the wait ends. */
  #card(
    kind: OpenPrompt['kind'],
    data: Record<string, unknown>,
    tabId: number,
    signal: AbortSignal,
  ): Promise<unknown | 'withdrawn'> {
    const prompt: OpenPrompt = {
      id: crypto.randomUUID(),
      kind,
      conversationId: 'browser',
      tabId,
      data,
      openedAt: new Date().toISOString(),
    };
    return new Promise(resolve => {
      if (signal.aborted) return resolve('withdrawn');
      this.#open.set(prompt.id, { prompt, resolve: a => resolve(a) });
      this.hooks.emit({ type: 'prompt_open', prompt });
      signal.addEventListener('abort', () => {
        if (this.#close(prompt.id, 'withdrawn')) resolve('withdrawn');
      });
    });
  }

  /** An answer from a panel. False when the card is not this store's or is no longer open. */
  answer(promptId: string, answer: unknown): boolean {
    const waiting = this.#open.get(promptId);
    if (!waiting) return false;
    const outcome = typeof answer === 'string' ? answer : ((answer as { outcome?: string })?.outcome ?? 'answered');
    if (!this.#close(promptId, outcome)) return false;
    waiting.resolve(answer);
    return true;
  }

  /** Every card of the session, withdrawn (the bridge stopped, or the worker restarted), and every grant with them. */
  withdrawAll(): void {
    this.#taskGrants.clear();
    for (const waiting of [...this.#open.values()]) {
      if (this.#close(waiting.prompt.id, 'withdrawn')) waiting.resolve('withdrawn');
    }
  }

  #close(promptId: string, outcome: string): boolean {
    if (!this.#open.delete(promptId)) return false;
    this.hooks.emit({ type: 'prompt_closed', id: promptId, outcome });
    return true;
  }

  /** The host's write policy for the external session, after the task's own grant. */
  decideWrite(question: WriteQuestion): WriteDecision {
    if (this.#granted(question.tabId)) return { decision: 'run', by: 'task', canRemember: false };
    return this.hooks.decideWrite(question);
  }

  #granted(tabId: number): boolean {
    const until = this.#taskGrants.get(Number(tabId));
    if (until === undefined) return false;
    if (Date.now() <= until) return true;
    this.#taskGrants.delete(Number(tabId));
    return false;
  }

  /** Allows the classified writes on this tab until the task ends; the user asked for it on a card. */
  allowTask(tabId: number): void {
    this.#taskGrants.set(Number(tabId), Date.now() + TASK_GRANT_MS);
  }

  /** Whether this tab already has the task's grant, for a panel that wants to say so. */
  taskGranted(tabId: number): boolean {
    return this.#granted(tabId);
  }

  /** Ends every task grant: the bridge stopped, or the user detached. */
  clearGrants(): void {
    this.#taskGrants.clear();
  }

  /** A note the external agent puts in the panel, in its own words. */
  note(text: string): void {
    this.hooks.emit({ type: 'browser-note', text, at: new Date().toISOString() });
  }

  /** What the external session is doing, for the panel's status line. */
  working(active: boolean, tabId?: number, lastAction?: string): void {
    this.#state = { active, tabId, lastAction };
    this.hooks.emit({ type: 'browser-session', ...this.#state });
  }

  /** The same line, for a panel that connected after the event went out. */
  state(): { active: boolean; tabId?: number; lastAction?: string } | null {
    return this.#state;
  }

  /** The layer's prompts for the external session's tabs. */
  userPrompt(): UserPrompt {
    return {
      confirm: async (request: ConfirmRequest, signal: AbortSignal): Promise<ConfirmAnswer> => {
        const site = request.site || siteOf(await this.hooks.tabUrl(request.tabId).catch(() => ''));
        const answer = await this.#card(
          'write-card',
          {
            category: request.category,
            action: request.action,
            target: request.target,
            site,
            frameHost: request.frameHost,
            destinationHost: request.destinationHost,
            intent: request.intent,
            reason: request.reason,
            canRemember: request.canRemember,
          },
          request.tabId,
          signal,
        );
        if (answer === 'approve-task') {
          // The user allowed the rest of this task on this tab: this write goes through, and so do the ones after it.
          this.allowTask(request.tabId);
          return 'approve';
        }
        const choice = answer === 'approve' || answer === 'approve-remember' ? answer : 'decline';
        if (choice === 'approve-remember' && request.canRemember && site) await this.hooks.remember(site);
        return choice;
      },
      // The external session gets no `human` capability, so the layer has no one to ask: a question is cancelled.
      ask: async (_request: AskRequest, _signal: AbortSignal): Promise<AskAnswer> => ({ outcome: 'cancel' }),
    };
  }
}

let current: BrowserPrompts | null = null;

/** The worker's one store, made with the panel broadcast; null in a build without the bridge. */
export function installBrowserPrompts(hooks: BrowserPromptsHooks): BrowserPrompts {
  current = new BrowserPrompts(hooks);
  return current;
}

export function browserPrompts(): BrowserPrompts | null {
  return current;
}
