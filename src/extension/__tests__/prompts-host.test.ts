// The glue between the layer's write cards and the side panel: the worker keeps the open card, the panel asks for the
// list and answers it over `chrome.runtime.sendMessage`. This is the path that was missing entirely before: without it
// a classified write on a site set to "ask" was declined without ever reaching a person.

import { describe, expect, it, beforeAll } from 'vitest';
import type { ConfirmRequest } from '@src/browser-control';
import type { PromptReply, PromptRequest } from '@src/ui/protocol';

type Listener = (message: PromptRequest, sender: unknown, respond: (reply: PromptReply) => void) => void;

const state: { listener?: Listener; sent: unknown[] } = { sent: [] };

beforeAll(async () => {
  const chromeStub = {
    runtime: {
      sendMessage: async (message: unknown) => {
        state.sent.push(message);
      },
      onMessage: {
        addListener: (listener: Listener) => {
          state.listener = listener;
        },
        removeListener: () => undefined,
      },
    },
    tabs: { get: async () => ({ id: 7, url: 'https://shop.test/cart' }) },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
        onChanged: { addListener: () => undefined },
      },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
  await import('../prompts-host');
});

function ask(message: PromptRequest): PromptReply {
  let reply: PromptReply | undefined;
  state.listener?.(message, {}, value => {
    reply = value;
  });
  if (!reply) throw new Error('the worker did not answer');
  return reply;
}

function request(overrides: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    id: 'r1',
    tabId: 7,
    category: 'submit',
    action: 'click',
    target: 'button "提交"',
    origin: 'https://shop.test',
    site: 'shop.test',
    reason: 'submits a form',
    canRemember: true,
    ...overrides,
  };
}

describe('write cards over runtime messages', () => {
  it('lists an open card and resolves it with the answer the panel sent', async () => {
    const { browserPrompts } = await import('../browser-prompts');
    const store = browserPrompts();
    if (!store) throw new Error('the prompt store was not installed');

    const controller = new AbortController();
    const answer = store.userPrompt().confirm(request(), controller.signal);
    // The worker announced the open card, so a panel that is already open hears about it.
    expect(state.sent.some(message => (message as { type?: string })?.type === 'prompt_open')).toBe(true);

    const listed = ask({ type: 'prompts:list' });
    expect(listed.prompts).toHaveLength(1);
    expect(listed.prompts[0].kind).toBe('write-card');
    expect(listed.prompts[0].data).toMatchObject({ action: 'click', site: 'shop.test' });

    const answered = ask({ type: 'prompt:answer', id: listed.prompts[0].id, answer: 'approve' });
    expect(answered.answered).toBe(true);
    expect(answered.prompts).toHaveLength(0);
    expect(await answer).toBe('approve');
  });

  it('answering a card that is not open reports false', () => {
    const answered = ask({ type: 'prompt:answer', id: 'not-open', answer: 'decline' });
    expect(answered.answered).toBe(false);
  });

  it('ignores a message it does not know', () => {
    expect(state.listener?.({} as PromptRequest, {}, () => undefined)).toBeUndefined();
  });
});
