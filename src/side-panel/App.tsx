// The side panel. It is the live DSH session over the Hub — hands and eyes, with Settings as the only door out. There is
// no second chat in here: the conversation, the model and the loop belong to DSH or to the MCP client above the layer.
import { useEffect } from 'react';
import { DEFAULT_SETTINGS, settingsStorage } from '@src/store/settings';
import { useStorage } from '@src/ui/hooks';
import { setLanguage, t, useLanguage } from '@src/ui/i18n';
import { applyTheme } from '@src/ui/theme';
import { websiteUrl } from '@src/ui/links';
import { LogoMark, SettingsIcon } from '@src/ui/icons';
import { DshChat } from './DshChat';

export function App() {
  useLanguage();
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  useEffect(() => void setLanguage(settings.uiLanguage), [settings.uiLanguage]);
  useEffect(() => applyTheme(settings.theme), [settings.theme]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-0.5 border-b border-nb-border/60 px-2">
        {/* The mark opens the website in a new tab. */}
        <a
          href={websiteUrl('/', 'side-panel')}
          target="_blank"
          rel="noreferrer"
          title={t('panel.website')}
          aria-label={t('panel.website')}
          className="mr-1 flex shrink-0 rounded-md p-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent">
          <LogoMark size={18} />
        </a>
        <h1 className="sr-only">{t('dsh.title')}</h1>
        <span className="flex-1" />
        <button
          type="button"
          title={t('panel.settings')}
          aria-label={t('panel.settings')}
          className="flex size-8 items-center justify-center rounded-lg text-nb-muted transition-colors hover:bg-nb-surface hover:text-nb-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-accent"
          onClick={() => void chrome.runtime.openOptionsPage()}>
          <SettingsIcon />
        </button>
      </header>
      <DshChat />
    </div>
  );
}
