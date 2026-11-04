// The write cards the layer opens for a classified write on a site whose rule is "ask". The worker holds them (see
// src/extension/prompts-host.ts); this only reads what is open and answers one. A card nobody answers is a decline
// when the layer's clock runs out, so the buttons say plainly that nothing has happened yet.
import { useEffect, useState } from 'react';
import { t } from '@src/ui/i18n';
import type { OpenPrompt, PromptReply, PromptRequest } from '@src/ui/protocol';

export type WriteAnswer = 'approve' | 'approve-remember' | 'approve-task' | 'decline';

/** One card, pure: the panel's own words around the facts the layer sent. */
export function WriteCard({ prompt, onAnswer }: { prompt: OpenPrompt; onAnswer: (answer: WriteAnswer) => void }) {
  const data = prompt.data as {
    action?: string;
    target?: string;
    site?: string;
    category?: string;
    reason?: string;
    canRemember?: boolean;
  };
  const action = String(data.action ?? 'act');
  const target = String(data.target ?? 'this');
  const site = String(data.site ?? '');
  return (
    <div
      role="group"
      aria-label={t('write.title', { action, target })}
      className="mx-3 mb-2 flex flex-col gap-2 rounded-2xl border border-amber-300/90 bg-amber-50/80 px-3.5 py-3 text-[13px] leading-normal text-amber-950 dark:border-amber-700/70 dark:bg-amber-950/50 dark:text-amber-50">
      <p className="flex items-center gap-2 font-semibold">
        <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
        {t('write.title', { action, target })}
      </p>
      {site ? <p className="text-amber-900/80 dark:text-amber-100/80">{t('write.site', { site })}</p> : null}
      {data.reason ? (
        <p className="whitespace-pre-wrap text-amber-900/90 dark:text-amber-100/90">{String(data.reason)}</p>
      ) : null}
      <div className="mt-0.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded-full bg-nb-fg px-3.5 py-1.5 text-xs font-medium text-nb-bg hover:opacity-85"
          onClick={() => onAnswer('approve')}>
          {t('write.allow')}
        </button>
        <button
          type="button"
          className="rounded-full border border-amber-400 bg-nb-bg px-3.5 py-1.5 text-xs hover:bg-amber-50 dark:bg-transparent dark:hover:bg-amber-900/30"
          title={t('write.allowTaskHint')}
          onClick={() => onAnswer('approve-task')}>
          {t('write.allowTask')}
        </button>
        {data.canRemember && site ? (
          <button
            type="button"
            className="rounded-full border border-amber-400 bg-nb-bg px-3.5 py-1.5 text-xs hover:bg-amber-50 dark:bg-transparent dark:hover:bg-amber-900/30"
            onClick={() => onAnswer('approve-remember')}>
            {t('write.allowSite', { site })}
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-full p-1.5 text-xs text-amber-800/80 hover:underline dark:text-amber-200/80"
          onClick={() => onAnswer('decline')}>
          {t('write.deny')}
        </button>
      </div>
    </div>
  );
}

/** The open write cards, kept in step with the worker. */
export function WriteCards() {
  const [prompts, setPrompts] = useState<OpenPrompt[]>([]);

  const ask = (message: PromptRequest) =>
    chrome.runtime.sendMessage(message).then(
      (reply: PromptReply | undefined) => setPrompts(reply?.prompts ?? []),
      () => setPrompts([]),
    );

  useEffect(() => {
    void ask({ type: 'prompts:list' });
    // The worker announces every open and close; re-reading the list is cheaper than tracking each id.
    const listen = (message: { type?: string } | undefined) => {
      if (message?.type === 'prompt_open' || message?.type === 'prompt_closed') void ask({ type: 'prompts:list' });
    };
    chrome.runtime.onMessage.addListener(listen);
    return () => chrome.runtime.onMessage.removeListener(listen);
  }, []);

  if (prompts.length === 0) return null;
  return (
    <section aria-label={t('write.heading')}>
      {prompts.map(prompt => (
        <WriteCard
          key={prompt.id}
          prompt={prompt}
          onAnswer={answer => void ask({ type: 'prompt:answer', id: prompt.id, answer })}
        />
      ))}
    </section>
  );
}
