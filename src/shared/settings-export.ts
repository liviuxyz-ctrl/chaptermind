import { DEFAULT_SETTINGS, type ExtensionSettings } from './types';

export const SENSITIVE_SETTINGS_KEYS = ['apiKey', 'githubToken'] as const;
export type SensitiveSettingsKey = (typeof SENSITIVE_SETTINGS_KEYS)[number];
export type NonSensitiveSettings = Omit<ExtensionSettings, SensitiveSettingsKey>;
export type SensitiveSettings = Pick<ExtensionSettings, SensitiveSettingsKey>;

const SENSITIVE_KEY_SET = new Set<string>(SENSITIVE_SETTINGS_KEYS);
const KNOWN_SETTINGS_KEYS = new Set<string>(Object.keys(DEFAULT_SETTINGS));

/** Return a copy of settings with all sensitive credentials stripped. */
export function exportNonSensitiveSettings(settings: ExtensionSettings): NonSensitiveSettings {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!SENSITIVE_KEY_SET.has(key)) {
      result[key] = settings[key as keyof ExtensionSettings];
    }
  }
  return result as NonSensitiveSettings;
}

/** Return only sensitive credentials (API key and GitHub token) for separate backup. */
export function exportSensitiveSettings(settings: ExtensionSettings): SensitiveSettings {
  return {
    apiKey: settings.apiKey ?? '',
    githubToken: settings.githubToken ?? '',
  };
}

/** Parse an imported settings JSON string, keeping only recognized ExtensionSettings keys. */
export function parseImportedSettingsJson(rawJson: string): Partial<ExtensionSettings> {
  const parsed: unknown = JSON.parse(rawJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object of ChapterMind settings.');
  }
  const source = parsed as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (KNOWN_SETTINGS_KEYS.has(key) && value !== undefined) {
      filtered[key] = value;
    }
  }
  if (Object.keys(filtered).length === 0) {
    throw new Error('No recognized ChapterMind settings keys found in JSON.');
  }
  return filtered as Partial<ExtensionSettings>;
}
