/**
 * The brain's model: any OpenAI-compatible chat endpoint. MiniMax M3.1 Flash by default.
 *
 *   HYPERLINK_MODEL_URL   the endpoint's base address (default https://api.minimax.io/v1)
 *   HYPERLINK_MODEL       the model (default MiniMax-M3.1-Flash-Preview)
 *   HYPERLINK_MODEL_KEY   its key (MINIMAX_API_KEY is used when this is not set)
 *   HYPERLINK_EFFORT      reasoning effort, when the model takes one (default medium)
 *
 * The brain wakes only to plan, make or repair; a working connector runs with no model at all.
 */

export interface ModelMessage { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }

export interface BrainModel {
  readonly name: string
  complete(messages: readonly ModelMessage[], signal?: AbortSignal): Promise<{ text: string; inputTokens: number; outputTokens: number }>
}

const TIMEOUT_MS = 180_000

export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): BrainModel {
  const base = (env.HYPERLINK_MODEL_URL?.trim() || 'https://api.minimax.io/v1').replace(/\/+$/u, '')
  const model = env.HYPERLINK_MODEL?.trim() || 'MiniMax-M3.1-Flash-Preview'
  const key = env.HYPERLINK_MODEL_KEY?.trim() || env.MINIMAX_API_KEY?.trim() || ''
  const effort = env.HYPERLINK_EFFORT?.trim() || 'medium'
  return {
    name: model,
    async complete(messages, signal) {
      if (!key) throw new Error('The brain has no model key: set HYPERLINK_MODEL_KEY (or MINIMAX_API_KEY).')
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, max_tokens: 16_000, ...(effort !== 'none' ? { reasoning_effort: effort } : {}) }),
        signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      })
      const body = await response.json().catch(() => null) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string }; base_resp?: { status_msg?: string } } | null
      if (!response.ok || !body?.choices?.[0]) throw new Error(`The model did not answer (${response.status}): ${body?.error?.message ?? body?.base_resp?.status_msg ?? 'no reply'}`)
      // Thinking written into the reply is not part of the answer.
      const text = (body.choices[0].message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/giu, '').trim()
      return { text, inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 }
    },
  }
}
