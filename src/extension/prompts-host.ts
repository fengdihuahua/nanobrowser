// The worker side of the write cards.
//
// The layer asks `decideWrite` for each classified write. The site's rule answers first (allow, ask, or blocked); when
// the answer is "ask", the layer opens a confirmation card, and this is what puts it in front of the user: the store
// keeps the open card and the side panel reads and answers it over `chrome.runtime.sendMessage`. A card nobody answers
// waits until the layer's clock runs out, and the layer then treats it as a decline, so nothing is dispatched unseen.
import { settingsStorage } from '@src/store/settings';
import { installBrowserPrompts } from './browser-prompts';
import { Permissions } from './permissions';
import type { PromptReply, PromptRequest } from '@src/ui/protocol';

export function startBrowserPrompts(): void {
  const permissions = new Permissions();
  void permissions.ready();

  const store = installBrowserPrompts({
    // Both cards and notes go to every open side panel; nobody listening is normal, not an error.
    emit: body => {
      void chrome.runtime.sendMessage(body).catch(() => undefined);
    },
    tabUrl: async tabId => (await chrome.tabs.get(tabId).catch(() => null))?.url ?? '',
    remember: site => permissions.allow(site),
    decideWrite: question => permissions.decide(settingsStorage.getSnapshot()?.defaultMode ?? 'ask', question),
  });

  chrome.runtime.onMessage.addListener((message: PromptRequest, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    if (message.type === 'prompts:list') {
      sendResponse({ prompts: store.prompts() } satisfies PromptReply);
      return undefined;
    }
    if (message.type === 'prompt:answer') {
      const answered = store.answer(String(message.id ?? ''), message.answer);
      sendResponse({ prompts: store.prompts(), answered } satisfies PromptReply);
      return undefined;
    }
    return undefined;
  });

  console.info('[prompts] write cards are wired');
}

// Registered at worker start, like every other listener: a prompt that arrives before this would be missed.
startBrowserPrompts();
