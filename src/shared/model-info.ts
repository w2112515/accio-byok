import type { ModelInfo, ProviderKind } from './types.ts'

/** Exact official model IDs only. Compatible endpoints can have different limits and prices. */
export function knownModelInfo(kind: ProviderKind, baseUrl: string, model: string): ModelInfo | undefined {
  let host: string
  try { host = new URL(baseUrl).hostname } catch { return undefined }
  if (kind !== 'anthropic' || host !== 'api.anthropic.com') return undefined
  // Verified 2026-09-30 against https://platform.claude.com/docs/en/models/overview.
  const models: Record<string, { context: number; output: number; inputPrice: number; outputPrice: number; thinking: ModelInfo['thinking'] }> = {
    'claude-opus-5-5': { context: 1_000_000, output: 128_000, inputPrice: 4, outputPrice: 20, thinking: 'adaptive' },
    'claude-sonnet-5-5': { context: 1_000_000, output: 128_000, inputPrice: 2, outputPrice: 10, thinking: 'adaptive' },
    'claude-fable-5-1': { context: 1_000_000, output: 128_000, inputPrice: 10, outputPrice: 50, thinking: 'adaptive' },
    'claude-haiku-4-5': { context: 200_000, output: 64_000, inputPrice: 1, outputPrice: 5, thinking: 'budget' },
    'claude-haiku-4-5-20251001': { context: 200_000, output: 64_000, inputPrice: 1, outputPrice: 5, thinking: 'budget' },
  }
  const m = models[model]
  if (!m) return undefined
  return {
    model, contextWindow: m.context, windowKind: 'context', maxOutputTokens: m.output,
    tools: true, vision: true, thinking: m.thinking, source: 'official',
    sourceUrl: 'https://platform.claude.com/docs/en/models/overview', checkedAt: Date.UTC(2026, 8, 30),
    pricing: { input: m.inputPrice, output: m.outputPrice },
  }
}

export function usableModelInfo(provider: { kind: ProviderKind; baseUrl: string; model: string; modelInfo?: ModelInfo }): ModelInfo | undefined {
  return provider.modelInfo?.model === provider.model ? provider.modelInfo : knownModelInfo(provider.kind, provider.baseUrl, provider.model)
}
