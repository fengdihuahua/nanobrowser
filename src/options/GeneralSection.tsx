// Settings → General: the default mode and the turn cap, the interface and answer languages, the theme and the page
// border, and the keyboard shortcut that opens the panel.
import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, settingsStorage } from '@src/store/settings';
import type { Theme, UiLanguage } from '@src/store/settings';
import { Button, Select, Switch } from '@src/ui/components';
import { useStorage } from '@src/ui/hooks';
import { t } from '@src/ui/i18n';
import { KeyboardIcon } from '@src/ui/icons';
import { LANGUAGE_NAMES } from '@src/ui/language';
import { SettingsCard, SettingsRow } from './SettingsCard';

/**
 * The `open-panel` command's key. Chrome keeps it on its own page (chrome://extensions/shortcuts), so it is read again
 * when this page gets the focus back.
 */
function KeyboardShortcut() {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    const read = () =>
      void chrome.commands
        .getAll()
        .then(list => setShortcut(list.find(c => c.name === 'open-panel')?.shortcut ?? ''))
        .catch(() => setShortcut(''));
    read();
    window.addEventListener('focus', read);
    return () => window.removeEventListener('focus', read);
  }, []);
  return (
    <SettingsCard title={t('general.keyboard')} description={t('general.keyboardHint')}>
      <SettingsRow
        label={t('general.openPanel')}
        description={
          <>
            {t('general.currentShortcut')}{' '}
            {shortcut ? (
              <kbd className="rounded-md border border-nb-border bg-nb-surface px-2 py-0.5 font-sans text-base tracking-[0.15em] text-nb-fg">
                {shortcut}
              </kbd>
            ) : shortcut === '' ? (
              t('general.noShortcut')
            ) : null}
          </>
        }>
        <Button
          className="inline-flex items-center gap-2"
          onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
          <KeyboardIcon />
          {t('general.configure')}
        </Button>
      </SettingsRow>
    </SettingsCard>
  );
}

/** The interface language, the browser's by default. */
export function UiLanguageRow() {
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  return (
    <SettingsRow label={t('language.ui')} description={t('language.uiHint')}>
      <Select
        aria-label={t('language.ui')}
        value={settings.uiLanguage}
        onChange={e => void settingsStorage.set(s => ({ ...s, uiLanguage: e.target.value as UiLanguage }))}>
        <option value="auto">{t('language.auto')}</option>
        {Object.entries(LANGUAGE_NAMES).map(([value, name]) => (
          <option key={value} value={value}>
            {name}
          </option>
        ))}
      </Select>
    </SettingsRow>
  );
}

export function GeneralSection() {
  const settings = useStorage(settingsStorage, DEFAULT_SETTINGS);
  return (
    <div className="flex flex-col gap-6">
      <h2 className="sr-only">{t('settings.nav.general')}</h2>
      <SettingsCard title={t('general.language')} className="flex flex-col gap-6">
        <UiLanguageRow />
      </SettingsCard>
      <SettingsCard title={t('general.appearance')} className="flex flex-col gap-6">
        <SettingsRow label={t('language.theme')}>
          <Select
            aria-label={t('language.theme')}
            value={settings.theme}
            onChange={e => void settingsStorage.set(s => ({ ...s, theme: e.target.value as Theme }))}>
            <option value="system">{t('theme.system')}</option>
            <option value="light">{t('theme.light')}</option>
            <option value="dark">{t('theme.dark')}</option>
          </Select>
        </SettingsRow>
        <SettingsRow label={t('general.pageBorder')} description={t('general.pageBorderHint')}>
          <Switch
            aria-label={t('general.pageBorder')}
            checked={settings.pageBorder}
            onChange={on => void settingsStorage.set(s => ({ ...s, pageBorder: on }))}
          />
        </SettingsRow>
      </SettingsCard>
      <KeyboardShortcut />
    </div>
  );
}
