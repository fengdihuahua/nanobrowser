// The extension's own settings in chrome.storage.local. The model, its key and the conversation are not here: they
// belong to DSH or to the MCP client above the layer.
import { createStorage } from './storage';
import type { PermissionMode } from './types';

export type UiLanguage = 'auto' | 'en' | 'zh_CN' | 'zh_TW';
export type Theme = 'system' | 'light' | 'dark';

export interface Settings {
  defaultMode: PermissionMode;
  theme: Theme;
  uiLanguage: UiLanguage;
  /** A glowing border on the pages a working session acts on. */
  pageBorder: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  defaultMode: 'ask',
  theme: 'system',
  uiLanguage: 'auto',
  pageBorder: true,
};

/** Stored settings over the defaults, so a field added later has its default. */
export function mergeSettings(stored: unknown): Settings {
  return { ...DEFAULT_SETTINGS, ...(stored && typeof stored === 'object' ? (stored as Partial<Settings>) : {}) };
}

export const settingsStorage = createStorage<Settings>('nb.settings', DEFAULT_SETTINGS, {
  liveUpdate: true,
  merge: mergeSettings,
});

/** A site's rule: one map, keyed with `siteOf`, one rule per site. */
export type SiteRule = 'allow' | 'ask' | 'block';

export interface SiteRuleEntry {
  rule: SiteRule;
  setAt: string;
}

export const siteRulesStorage = createStorage<Record<string, SiteRuleEntry>>('nb.siteRules', {}, { liveUpdate: true });

/**
 * The policy for a classified write: a site's rule decides, otherwise the mode. A pure function of two values.
 */
export function decideWrite(mode: PermissionMode, rule: 'allow' | 'ask' | undefined): 'run' | 'ask' {
  if (rule) return rule === 'allow' ? 'run' : 'ask';
  return mode === 'auto' ? 'run' : 'ask';
}
