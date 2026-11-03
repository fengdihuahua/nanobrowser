// Settings → Privacy: the policy link. The extension sends no analytics of its own: the Hub and DSH own usage.
import { t } from '@src/ui/i18n';
import { SettingsCard } from './SettingsCard';

export const PRIVACY_URL = 'https://github.com/nanobrowser/nanobrowser/blob/HEAD/PRIVACY.md';

export function PrivacyCard() {
  return (
    <SettingsCard title={t('privacy.title')} className="flex flex-col gap-6">
      <p className="text-sm leading-relaxed text-nb-fg/85">{t('privacy.pingHint')}</p>
      <a className="self-start text-sm text-nb-accent underline" href={PRIVACY_URL} target="_blank" rel="noreferrer">
        {t('privacy.policy')}
      </a>
    </SettingsCard>
  );
}
