import type { ModelInfo, Provider, ProviderKind } from './types.ts'
import { tx } from './i18n.ts'

/** Exact official model IDs only. Compatible endpoints can have different limits and prices. */
function claudeModelInfo(kind: ProviderKind, baseUrl: string, model: string): ModelInfo | undefined {
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
    effortLevels: m.thinking === 'adaptive' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [], sampling: false,
    sourceUrl: 'https://platform.claude.com/docs/en/models/overview', checkedAt: Date.UTC(2026, 8, 30),
    pricing: { input: m.inputPrice, output: m.outputPrice },
  }
}

/** Source-backed fallbacks, never inferred from a model name on a different service. */
export function knownModelInfo(kind: ProviderKind, baseUrl: string, model: string): ModelInfo | undefined {
  const claude = claudeModelInfo(kind, baseUrl, model)
  if (claude) return claude
  let url: URL
  try { url = new URL(baseUrl) } catch { return undefined }
  const host = url.hostname
  const path = url.pathname.replace(/\/+$/, '')
  const info = (sourceUrl: string, values: Partial<ModelInfo>): ModelInfo => ({ model, source: 'official', sourceUrl, checkedAt: Date.UTC(2026, 9, 2), windowKind: 'context', ...values })
  if (kind === 'openai' && host === 'api.openai.com' && path === '/v1') {
    const rows: Record<string, [number, number, string[]]> = {
      'gpt-6.1-sol': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      'gpt-6-sol': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      'gpt-6-astra': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      'gpt-6-luna': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      'gpt-5.6': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      'gpt-5.6-sol': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      'gpt-5.6-terra': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      'gpt-5.6-luna': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh', 'max']],
      'gpt-5.5': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh']],
      'gpt-5.4': [1_050_000, 128_000, ['low', 'medium', 'high', 'xhigh']],
      'gpt-5.4-mini': [400_000, 128_000, ['low', 'medium', 'high', 'xhigh']],
      'gpt-5.4-nano': [400_000, 128_000, ['low', 'medium', 'high', 'xhigh']],
      'gpt-5.2': [400_000, 128_000, ['low', 'medium', 'high', 'xhigh']],
      'gpt-5.1': [400_000, 128_000, ['low', 'medium', 'high']],
      'gpt-5': [400_000, 128_000, ['minimal', 'low', 'medium', 'high']],
      'gpt-5-mini': [400_000, 128_000, []],
      'gpt-5-nano': [400_000, 128_000, []],
      'gpt-4.1': [1_047_576, 32_768, []],
      'gpt-4.1-mini': [1_047_576, 32_768, []],
      'gpt-4.1-nano': [1_047_576, 32_768, []],
      'gpt-4o': [128_000, 16_384, []],
      'gpt-4o-mini': [128_000, 16_384, []],
      'o3': [200_000, 100_000, []],
      'o4-mini': [200_000, 100_000, []],
    }
    const row = rows[model]
    if (row) return info(`https://developers.openai.com/api/docs/models/${model}`, { contextWindow: row[0], maxOutputTokens: row[1], effortLevels: row[2], sampling: false, tools: true, vision: true, recommendedApi: 'responses' })
  }
  if (kind === 'openai' && ['api.moonshot.cn', 'api.moonshot.ai'].includes(host) && path === '/v1') {
    const windows: Record<string, number> = { 'kimi-k3': 1_048_576, 'kimi-k2.7-code': 262_144, 'kimi-k2.7-code-highspeed': 262_144, 'kimi-k2.6': 262_144 }
    if (windows[model]) return info('https://platform.kimi.ai/docs/models', { contextWindow: windows[model], effortLevels: model === 'kimi-k3' ? ['low', 'high', 'max'] : [], sampling: false, reasoningContent: true, tools: true, vision: true })
  }
  if (kind === 'openai' && ['api.kimi.com', 'api.kimi.ai'].includes(host) && path === '/coding/v1') {
    const windows: Record<string, number | undefined> = { k3: undefined, 'k3-256k': 262_144, 'kimi-for-coding': 1_048_576, 'kimi-for-coding-highspeed': 262_144 }
    // k3's allowance depends on the membership tier; do not claim 1M for every key.
    if (Object.hasOwn(windows, model)) return info('https://www.kimi.com/code/docs/kimi-code/models.html', { contextWindow: windows[model], effortLevels: ['low', 'high', 'max'], sampling: false, reasoningContent: true, tools: true })
  }
  if (kind === 'openai' && host === 'api.deepseek.com' && ['', '/v1'].includes(path) && ['deepseek-flash', 'deepseek-v4-pro'].includes(model)) {
    return info('https://api-docs.deepseek.com/api/list-models/', { contextWindow: 1_048_576, maxOutputTokens: 393_216, effortLevels: ['low', 'high', 'max'], reasoningContent: true, sampling: false, tools: true, vision: model === 'deepseek-flash' })
  }
  if (kind === 'openai' && host === 'open.bigmodel.cn' && ['/api/paas/v4', '/api/coding/paas/v4'].includes(path)) {
    if (['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2'].includes(model)) return info(`https://docs.bigmodel.cn/cn/guide/models/${model.includes('flash') ? 'vlm/glm-5.3-flash' : `text/${model}`}`, { contextWindow: 1_000_000, maxOutputTokens: 128_000, effortLevels: model === 'glm-5.2' ? [] : ['low', 'high', 'max'], sampling: false, reasoningContent: true, tools: true, vision: model.includes('flash') })
    if (['glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.7-flashx', 'glm-4.6'].includes(model)) return info(`https://docs.bigmodel.cn/cn/guide/models/text/${model === 'glm-4.7-flashx' ? 'glm-4.7' : model}`, { contextWindow: 200_000, maxOutputTokens: 128_000, sampling: false, reasoningContent: true, tools: true, vision: false })
  }
  if (kind === 'openai' && ['api.minimaxi.com', 'api.minimax.io'].includes(host) && path === '/v1') {
    const windows: Record<string, number> = { 'MiniMax-M3.1-Flash-Preview': 1_000_000, 'MiniMax-M3': 1_000_000, 'MiniMax-M2.7': 204_800, 'MiniMax-M2.7-highspeed': 204_800, 'MiniMax-M2.5': 204_800, 'MiniMax-M2.5-highspeed': 204_800, 'MiniMax-M2.1': 204_800, 'MiniMax-M2.1-highspeed': 204_800, 'MiniMax-M2': 204_800 }
    if (windows[model]) return info('https://platform.minimax.io/docs/guides/text-generation', { contextWindow: windows[model], reasoningContent: true, sampling: false, effortLevels: model === 'MiniMax-M3.1-Flash-Preview' ? ['low', 'medium', 'high', 'xhigh', 'max'] : [], tools: true })
  }
  if (kind === 'gemini' && host === 'generativelanguage.googleapis.com') {
    const id = model.replace(/^models\//, '')
    if (['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'].includes(id)) return info(`https://ai.google.dev/gemini-api/docs/models/${id}`, { contextWindow: 1_048_576, windowKind: 'input', maxOutputTokens: 65_536, thinking: id.startsWith('gemini-2.5-') ? 'budget' : 'adaptive', effortLevels: id.startsWith('gemini-2.5-') ? [] : ['low', 'medium', 'high'], sampling: false, tools: true, vision: true })
  }
  if (kind === 'openai' && ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'coding.dashscope.aliyuncs.com', 'token-plan.cn-beijing.maas.aliyuncs.com'].includes(host)) {
    const models: Record<string, number> = { 'qwen3.8-max': 131_072, 'qwen3.8-max-0902': 131_072, 'qwen3.8-max-2026-09-02': 131_072, 'qwen3.8-flash': 131_072, 'qwen3.7-max': 131_072, 'qwen3.7-plus': 131_072, 'qwen3.7-flash': 131_072, 'qwen3.6-plus': 65_536, 'qwen3.6-flash': 65_536, 'qwen3.5-plus': 65_536, 'qwen3.5-flash': 65_536, 'qwen3-coder-plus': 65_536 }
    if (models[model]) return info(`https://help.aliyun.com/zh/model-studio/${model.startsWith('qwen3.8-max') ? 'qwen3-8-max' : model.replace('.', '-')}`, { contextWindow: 1_000_000, maxOutputTokens: models[model], reasoningContent: model !== 'qwen3-coder-plus', sampling: false, tools: true })
  }
  return undefined
}

type ModelProvider = Pick<Provider, 'kind' | 'baseUrl' | 'model' | 'modelInfo'>
export function usableModelInfo(provider: ModelProvider, model = provider.model): ModelInfo | undefined {
  const known = knownModelInfo(provider.kind, provider.baseUrl, model)
  const saved = provider.modelInfo?.model === model ? provider.modelInfo : undefined
  if (!saved) return known
  if (saved.source === 'user') return saved
  // Partial API metadata must not erase independently verified capabilities.
  return { ...known, ...Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== undefined)) } as ModelInfo
}

/** Resolve on every request, after Accio's model mapping; never borrow the default model's limits. */
export function autoParameters<T extends Pick<Provider, 'kind' | 'baseUrl' | 'model' | 'modelInfo' | 'parameterMode' | 'authMode'>>(provider: T, model = provider.model): T & Partial<Provider> {
  if (provider.parameterMode !== 'auto') return provider
  const info = usableModelInfo(provider, model)
  const nativeClaude = provider.kind === 'anthropic' && new URL(provider.baseUrl).hostname === 'api.anthropic.com'
  // Sampling support can depend on the reasoning mode even when metadata lists it.
  // Let the server choose compatible defaults; Custom keeps explicit forwarding.
  return { ...provider, maxOutputTokens: undefined, sendSampling: false, sendReasoningEffort: !!info?.effortLevels?.length, sendReasoningContent: info?.reasoningContent === true, thinking: info?.thinking ?? 'off', thinkingBudget: 8000, promptCaching: nativeClaude, ...(info?.recommendedApi && provider.authMode !== 'subscription-key' ? { openaiApi: info.recommendedApi } : {}) }
}

type ReasoningProvider = ModelProvider & Pick<Provider, 'parameterMode' | 'reasoningPreference'>

/** Exact choices must remain valid for the actual target; never silently clamp or omit them. */
export function reasoningEffortIssue(provider: ReasoningProvider, model = provider.model): string | undefined {
  const effort = provider.reasoningPreference
  if (provider.parameterMode !== 'auto' || !effort || ['auto', 'fast', 'deep'].includes(effort)) return undefined
  const levels = usableModelInfo(provider, model)?.effortLevels
  if (levels?.includes(effort)) return undefined
  return levels?.length
    ? tx(`Model ${model} does not support effort ${effort} on this connection. Supported: ${levels.join(', ')}. Choose a supported level or Model default.`, `当前连接的模型 ${model} 不支持推理档位 ${effort}；可选：${levels.join('、')}。请选择支持的档位或“模型默认”。`)
    : tx(`Effort ${effort} has not been confirmed for model ${model} on this connection. Read its model information or choose Model default.`, `当前连接的模型 ${model} 尚未确认支持推理档位 ${effort}。请读取模型信息，或选择“模型默认”。`)
}

export function autoEffort(provider: ReasoningProvider, model: string): string | undefined {
  if (provider.parameterMode !== 'auto' || !provider.reasoningPreference || provider.reasoningPreference === 'auto') return undefined
  const issue = reasoningEffortIssue(provider, model)
  if (issue) throw new Error(issue)
  if (!['fast', 'deep'].includes(provider.reasoningPreference)) return provider.reasoningPreference
  const levels = usableModelInfo(provider, model)?.effortLevels?.filter((v) => v !== 'none')
  if (!levels?.length) return undefined
  return provider.reasoningPreference === 'fast' ? levels[0] : levels[levels.length - 1]
}
