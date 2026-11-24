import type { ExtensionSettings } from './types';

function modelDisallowsCustomTemperature(model: string): boolean {
  return /^(?:.+\/)?(o[1-9]|gpt-5)/i.test(model.trim());
}

export async function callAiProvider(
  settings: ExtensionSettings,
  prompt: string,
  expectJson = false,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const provider = settings.apiProvider;
  const apiKey = settings.apiKey.trim();
  const model = settings.apiModel.trim();

  if (provider !== 'custom' && !apiKey) {
    throw new Error(`No API key configured for ${provider}. Add one in Settings or use Subscription mode.`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);

  try {
    if (provider === 'gemini') {
      const targetModel = model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        targetModel
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const body: Record<string, unknown> = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          ...(expectJson ? { responseMimeType: 'application/json' } : {}),
        },
      };

      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new Error('Gemini returned an empty response.');
      return text;
    }

    if (provider === 'anthropic') {
      const targetModel = model || 'claude-sonnet-4-20250514';
      const res = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: targetModel,
          max_tokens: 4096,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text =
        data.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
      if (!text) throw new Error('Anthropic returned an empty response.');
      return text;
    }

    // OpenAI or Custom (OpenAI-compatible: Ollama, LM Studio, OpenRouter, etc.)
    const baseUrl =
      provider === 'openai'
        ? 'https://api.openai.com/v1'
        : (settings.customBaseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    const targetModel = model || (provider === 'openai' ? 'gpt-4.1-mini' : 'llama3.2');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const sendChatCompletion = (includeTemperature: boolean) => {
      const payload: Record<string, unknown> = {
        model: targetModel,
        messages: [{ role: 'user', content: prompt }],
      };
      if (includeTemperature) {
        payload.temperature = 0.2;
      }
      return fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    };

    const allowTemp = !modelDisallowsCustomTemperature(targetModel);
    let res = await sendChatCompletion(allowTemp);

    if (!res.ok) {
      const errText = await res.text();
      // Auto-retry without temperature if the model rejects custom temperature values
      if (res.status === 400 && allowTemp && /temperature/i.test(errText)) {
        res = await sendChatCompletion(false);
        if (!res.ok) {
          const retryErr = await res.text();
          throw new Error(`API HTTP ${res.status} (${baseUrl}): ${retryErr.slice(0, 300)}`);
        }
      } else {
        throw new Error(`API HTTP ${res.status} (${baseUrl}): ${errText.slice(0, 300)}`);
      }
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('API returned an empty completion.');
    return text;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('AI API request timed out after 90s.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
