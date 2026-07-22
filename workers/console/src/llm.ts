/**
 * Minimal dual-format LLM client (PROJECT_PLAN.md §13 — AI analysis reports).
 *
 * Supports two on-the-wire formats the deployer picks in console settings:
 *   - 'anthropic'  → POST {base}/v1/messages, `x-api-key` + `anthropic-version`,
 *                    response `content[].text`.
 *   - 'openai'     → POST {base}/chat/completions, `Authorization: Bearer`,
 *                    response `choices[0].message.content`. This covers OpenAI
 *                    itself and every OpenAI-compatible endpoint (DeepSeek,
 *                    OpenRouter, local vLLM/Ollama, …), so `base` is fully
 *                    user-configurable.
 *
 * The provider, base URL, model name and API key are all supplied by the
 * deployer (stored in instance_settings, edited via the console). No secret is
 * ever written into a repo file (§21); the key lives only in the deployer's own
 * D1 and is never returned to the browser.
 */

export type AiProvider = 'openai' | 'anthropic';

export interface AiConfig {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/** Sensible default base URLs when the deployer leaves the field blank. */
export const DEFAULT_BASE_URL: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Read a bounded slice of the provider's error body for diagnostics (never the
 *  key — only the upstream's own message), so the console can show *why* a call
 *  failed (bad key, unknown model, rate limit) instead of a bare 500. */
async function errorText(res: Response): Promise<string> {
  let body = '';
  try { body = (await res.text()).slice(0, 500); } catch { /* ignore */ }
  return body || res.statusText || `HTTP ${res.status}`;
}

/**
 * One-shot completion. Returns the assistant's text. Throws LlmError on a
 * non-2xx upstream response (status carried through so the caller can map it).
 */
export async function callLLM(cfg: AiConfig, system: string, user: string, maxTokens = 2200): Promise<string> {
  const base = (cfg.baseUrl || DEFAULT_BASE_URL[cfg.provider]).replace(/\/+$/, '');

  if (cfg.provider === 'anthropic') {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new LlmError(res.status, await errorText(res));
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
    if (!text) throw new LlmError(502, 'empty response from model');
    return text;
  }

  // openai-compatible
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new LlmError(res.status, await errorText(res));
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = (data.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new LlmError(502, 'empty response from model');
  return text;
}
