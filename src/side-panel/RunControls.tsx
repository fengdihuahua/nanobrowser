// The user during a run: Continue after the turn cap, Resume after a restart, and the queue of messages typed while the
// agent works. There is no Take over: Stop gives the page back to the user, and a message carries the task on.
import type { QueuedMessage, RunStatus } from '@src/store/types';
import { t } from '@src/ui/i18n';

const button =
  'rounded-lg border border-nb-border bg-nb-bg px-2.5 py-1 text-xs font-medium shadow-sm transition-colors hover:border-nb-accent/40 hover:bg-nb-surface';

export function RunBar({
  status,
  onContinue,
  onResume,
}: {
  status: RunStatus;
  onContinue: () => void;
  onResume: () => void;
}) {
  if (status === 'capped') {
    return (
      <Bar text={t('run.capped')}>
        <button type="button" className={button} onClick={onContinue}>
          {t('run.continue')}
        </button>
      </Bar>
    );
  }
  if (status === 'interrupted') {
    return (
      <Bar text={t('run.interrupted')}>
        <button type="button" className={button} onClick={onResume}>
          {t('run.resume')}
        </button>
      </Bar>
    );
  }
  return null;
}

function Bar({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="mx-3 mb-1 flex items-center gap-2 rounded-xl bg-nb-surface px-3 py-1.5 text-xs">
      <span className="flex-1">{text}</span>
      {children}
    </div>
  );
}

export function QueueList({
  items,
  onEdit,
  onDelete,
}: {
  items: QueuedMessage[];
  onEdit: (item: QueuedMessage) => void;
  onDelete: (item: QueuedMessage) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mx-3 mb-1 flex flex-col gap-1 rounded-xl bg-nb-surface/70 px-3 py-1.5 text-xs">
      <span className="text-[11px] text-nb-muted">{t('queue.title')}</span>
      {items.map(item => (
        <div key={item.id} className="flex items-start gap-3">
          <span className="min-w-0 flex-1 truncate text-nb-fg/90">{item.text}</span>
          <button type="button" className="shrink-0 text-nb-link hover:underline" onClick={() => onEdit(item)}>
            {t('queue.edit')}
          </button>
          <button type="button" className="shrink-0 text-nb-link hover:underline" onClick={() => onDelete(item)}>
            {t('queue.delete')}
          </button>
        </div>
      ))}
    </div>
  );
}
