import { describe, expect, it } from 'vitest';
import type { ConfirmRequest, WriteQuestion } from '@src/browser-control';
import { BrowserPrompts } from '../browser-prompts';
import type { OpenPrompt, PanelEventBody } from '@src/ui/protocol';

function setup() {
  const events: PanelEventBody[] = [];
  const remembered: string[] = [];
  const asked: WriteQuestion[] = [];
  const store = new BrowserPrompts({
    emit: body => events.push(body),
    tabUrl: async () => 'https://shop.test/cart',
    remember: async site => {
      remembered.push(site);
    },
    decideWrite: question => {
      asked.push(question);
      return { decision: 'ask', canRemember: true };
    },
  });
  return { store, events, remembered, asked };
}

function request(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    id: 'r1',
    tabId: 12,
    category: 'submit',
    action: 'click',
    target: 'button "Place order"',
    origin: 'https://shop.test',
    site: 'shop.test',
    reason: 'submits a form',
    canRemember: true,
    ...overrides,
  };
}

function opened(events: PanelEventBody[]): OpenPrompt[] {
  return events.flatMap(e => (e.type === 'prompt_open' ? [e.prompt] : []));
}

describe('BrowserPrompts', () => {
  it('opens a write card and resolves an approval', async () => {
    const { store, events } = setup();
    const answer = store.userPrompt().confirm(request(), new AbortController().signal);

    const [card] = opened(events);
    expect(card.kind).toBe('write-card');
    expect(card.tabId).toBe(12);
    expect(card.data).toMatchObject({ category: 'submit', site: 'shop.test', canRemember: true });
    expect(store.prompts().map(p => p.id)).toEqual([card.id]);

    expect(store.answer(card.id, 'approve')).toBe(true);
    await expect(answer).resolves.toBe('approve');
    expect(store.prompts()).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'prompt_closed', id: card.id, outcome: 'approve' });
  });

  it('names the site from the tab when the request has none', async () => {
    const { store, events } = setup();
    void store.userPrompt().confirm(request({ site: '', origin: '' }), new AbortController().signal);
    // The store reads the tab's address before it opens the card.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(opened(events)[0].data.site).toBe('shop.test');
  });

  it('remembers the site only when the card allows it and the user chose so', async () => {
    const { store, events, remembered } = setup();
    const answer = store.userPrompt().confirm(request(), new AbortController().signal);
    store.answer(opened(events)[0].id, 'approve-remember');

    await expect(answer).resolves.toBe('approve-remember');
    expect(remembered).toEqual(['shop.test']);
  });

  it('declines when the wait ends: a card nobody answered dispatches nothing', async () => {
    const { store, events } = setup();
    const abort = new AbortController();
    const answer = store.userPrompt().confirm(request(), abort.signal);

    abort.abort();

    await expect(answer).resolves.toBe('decline');
    expect(events.at(-1)).toMatchObject({ type: 'prompt_closed', outcome: 'withdrawn' });
    expect(store.prompts()).toEqual([]);
  });

  it('answers only its own cards', () => {
    const { store } = setup();
    expect(store.answer('a-card-of-a-conversation', 'approve')).toBe(false);
  });

  it('withdraws every card when the session ends', async () => {
    const { store, events } = setup();
    const first = store.userPrompt().confirm(request(), new AbortController().signal);
    const second = store.userPrompt().confirm(request({ id: 'r2' }), new AbortController().signal);
    expect(store.prompts()).toHaveLength(2);

    store.withdrawAll();

    await expect(first).resolves.toBe('decline');
    await expect(second).resolves.toBe('decline');
    expect(store.prompts()).toEqual([]);
    expect(events.filter(e => e.type === 'prompt_closed')).toHaveLength(2);
  });

  it('cancels a question: the external session has no one to ask', async () => {
    const { store } = setup();
    await expect(
      store
        .userPrompt()
        .ask({ id: 'a1', tabId: 12, kind: 'input', message: 'Which size?', origin: '' }, new AbortController().signal),
    ).resolves.toEqual({ outcome: 'cancel' });
  });
});
