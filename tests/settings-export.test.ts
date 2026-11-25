import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/types';
import {
  exportNonSensitiveSettings,
  exportSensitiveSettings,
  parseImportedSettingsJson,
} from '../src/shared/settings-export';

describe('settings-export', () => {
  const sampleSettings = {
    ...DEFAULT_SETTINGS,
    apiKey: 'AIzaSecretKey123',
    githubToken: 'ghp_SecretToken456',
    githubRepo: 'liviuxyz-ctrl/chaptermind-kb',
    topicsIgnore: ['crypto', 'image models'],
  };

  it('excludes sensitive keys from non-sensitive export', () => {
    const safe = exportNonSensitiveSettings(sampleSettings);
    expect(safe).not.toHaveProperty('apiKey');
    expect(safe).not.toHaveProperty('githubToken');
    expect(safe.githubRepo).toBe('liviuxyz-ctrl/chaptermind-kb');
    expect(safe.topicsIgnore).toEqual(['crypto', 'image models']);
  });

  it('includes only sensitive keys in sensitive export', () => {
    const secrets = exportSensitiveSettings(sampleSettings);
    expect(secrets).toEqual({
      apiKey: 'AIzaSecretKey123',
      githubToken: 'ghp_SecretToken456',
    });
  });

  it('parses valid settings JSON and drops unknown keys', () => {
    const parsed = parseImportedSettingsJson(
      JSON.stringify({
        githubRepo: 'owner/repo',
        apiKey: 'secret',
        unknownExtraField: 'ignored',
      })
    );
    expect(parsed).toEqual({
      githubRepo: 'owner/repo',
      apiKey: 'secret',
    });
  });

  it('rejects arrays or objects with no recognized settings', () => {
    expect(() => parseImportedSettingsJson('[]')).toThrow();
    expect(() => parseImportedSettingsJson('{"foo":"bar"}')).toThrow();
  });
});
