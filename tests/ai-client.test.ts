import { describe, expect, it } from 'vitest';
import { callAiProvider } from '../src/shared/ai-client';
import { DEFAULT_SETTINGS, type ExtensionSettings } from '../src/shared/types';

function makeOpenAiSettings(model: string): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    apiProvider: 'openai',
    apiKey: 'sk-test',
    apiModel: model,
  };
}

describe('callAiProvider temperature handling', () => {
  it('omits temperature for gpt-5 and o-series reasoning models on the first request', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const mockFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
        { status: 200 }
      );
    };

    const reply = await callAiProvider(
      makeOpenAiSettings('gpt-5-mini'),
      'Reply OK',
      false,
      mockFetch as typeof fetch
    );
    expect(reply).toBe('OK');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.temperature).toBeUndefined();
  });

  it('retries without temperature if an OpenAI-compatible model rejects temperature 0.2 with HTTP 400', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const mockFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
              type: 'invalid_request_error',
              param: 'temperature',
              code: 'unsupported_value',
            },
          }),
          { status: 400 }
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
        { status: 200 }
      );
    };

    const reply = await callAiProvider(
      makeOpenAiSettings('some-future-reasoning-model'),
      'Reply OK',
      false,
      mockFetch as typeof fetch
    );
    expect(reply).toBe('OK');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.temperature).toBe(0.2);
    expect(bodies[1]?.temperature).toBeUndefined();
  });
});
