// The browser-side view of an external (DSH) session: which tab it is working on, what it did last, and the notes it
// put here. It says nothing when no external session is attached, so a normal conversation sees no extra chrome.
import { t } from '@src/ui/i18n';
import { plain } from './Cards';

export function BrowserBar({
  browser,
  notes,
}: {
  browser: { active: boolean; tabId?: number; lastAction?: string };
  notes: Array<{ text: string; at: string }>;
}) {
  if (!browser.active && !browser.lastAction && !notes.length) return null;
  const last = notes.at(-1);
  return (
    <div className="mx-3 mb-1 rounded-xl bg-nb-surface/70 px-3 py-1.5 text-[11.5px] text-nb-muted">
      {browser.active ? (
        <p className="flex flex-wrap items-center gap-1.5">
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full bg-nb-accent" />
          <span className="font-medium text-nb-fg">{t('browser.active')}</span>
          {browser.lastAction ? <span>· {plain(browser.lastAction)}</span> : null}
        </p>
      ) : browser.lastAction ? (
        <p className="truncate">
          {t('browser.last')} {plain(browser.lastAction)}
        </p>
      ) : null}
      {last ? (
        <p className="mt-1 italic">
          {t('browser.note')} {plain(last.text)}
        </p>
      ) : null}
    </div>
  );
}
