import { tr } from '../../../shared/i18n.ts'
import { autoEffort, usableModelInfo } from '../../../shared/model-info.ts'
import type { ModelInfo, Provider } from '../../../shared/types.ts'
import {
  UpstreamError,
  newToolId,
  parseArgs,
  unwrapSignature,
  wrapSignature,
  type AccioRequest,
  type AdapterEvent,
  type Usage,
} from '../accio.ts'
import { readSse, tryJson } from '../sse.ts'
import { ensureOk, mergeHeaders, positiveTokens, providerUrl, requireBody, resolveMaxTokens, signatureOwner, type Adapter, type AdapterContext, type FetchLike } from './common.ts'

type Part = Record<string, unknown>

/**
 * Gemini 3 rejects replayed function calls without a thought signature. For calls that
 * came from another backend Google documents this sentinel to skip validation.
 */
const SKIP_SIGNATURE = 'skip_thought_signature_validator'

function headers(provider: Provider): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) h['x-goog-api-key'] = provider.apiKey
  return mergeHeaders(h, provider.extraHeaders)
}

function responseObject(responseJson: string): Record<string, unknown> {
  if (!responseJson) return { result: '' }
  try {
    const v = JSON.parse(responseJson)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const { __accio_store_context: _drop, ...rest } = v as Record<string, unknown>
      return rest
    }
    return { result: v }
  } catch {
    return { result: responseJson }
  }
}

export function toGeminiContents(req: AccioRequest, provider: Provider, model = provider.model): { role: string; parts: Part[] }[] {
  const out: { role: string; parts: Part[] }[] = []
  for (const c of req.contents) {
    const isModel = c.role === 'model' || c.role === 'assistant'
    const parts: Part[] = []
    let firstCall = true
    for (const p of c.parts) {
      const sig = unwrapSignature(signatureOwner(provider, model), p.thoughtSignature ?? p.functionCall?.thoughtSignature)
      if (p.functionCall) {
        const part: Part = {
          functionCall: { name: p.functionCall.name, args: parseArgs(p.functionCall.argsJson), ...(p.functionCall.id ? { id: p.functionCall.id } : {}) },
        }
        // Only the first call of a turn carries the signature for parallel calls.
        if (sig) part.thoughtSignature = sig
        else if (isModel && firstCall) part.thoughtSignature = SKIP_SIGNATURE
        firstCall = false
        parts.push(part)
      } else if (p.functionResponse) {
        parts.push({
          functionResponse: {
            name: p.functionResponse.name,
            response: responseObject(p.functionResponse.responseJson),
            ...(p.functionResponse.id ? { id: p.functionResponse.id } : {}),
          },
        })
      } else if (p.inlineData?.data) {
        parts.push({ inlineData: { mimeType: p.inlineData.mimeType, data: p.inlineData.data } })
      } else if (p.fileData?.fileUri) {
        const uri = p.fileData.fileUri
        if (uri.startsWith('gs://') || uri.includes('generativelanguage.googleapis.com')) {
          parts.push({ fileData: { mimeType: p.fileData.mimeType, fileUri: uri } })
        } else {
          // Preserve protocol fallback text independently of the display language.
          parts.push({ text: `[文件] ${uri}` })
        }
      } else if (p.text) {
        if (p.thought) {
          // Thought text is not required for replay; keep only a signature when it is ours.
          if (sig && isModel) parts.push({ text: p.text, thought: true, thoughtSignature: sig })
          continue
        }
        const part: Part = { text: p.text }
        if (sig && isModel) part.thoughtSignature = sig
        parts.push(part)
      }
    }
    if (!parts.length) continue
    const role = isModel ? 'model' : 'user'
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  if (!out.length) out.push({ role: 'user', parts: [{ text: '(continue)' }] })
  return out
}

const LEVELS = ['minimal', 'low', 'medium', 'high']

export function buildGeminiBody(req: AccioRequest, ctx: Pick<AdapterContext, 'provider' | 'model'>): Record<string, unknown> {
  const { provider } = ctx
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: resolveMaxTokens(req, provider, 16384, ctx.model),
  }
  if (provider.sendSampling) {
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature
    if (req.topP !== undefined) generationConfig.topP = req.topP
  }
  if (req.stopSequences.length) generationConfig.stopSequences = req.stopSequences.slice(0, 5)
  const thinkingConfig: Record<string, unknown> = { includeThoughts: true }
  if (provider.sendReasoningEffort) {
    const level = provider.parameterMode === 'auto' ? autoEffort(provider, ctx.model) : req.thinkingLevel?.toLowerCase() ?? req.reasoningEffort?.toLowerCase()
    if (level) {
      const mapped = LEVELS.includes(level) ? level : level === 'xhigh' || level === 'max' ? 'high' : undefined
      if (mapped) thinkingConfig.thinkingLevel = mapped
    } else if (provider.parameterMode !== 'auto' && req.thinkingBudget !== undefined) {
      thinkingConfig.thinkingBudget = req.thinkingBudget
    }
  }
  if (provider.parameterMode !== 'auto' || (usableModelInfo(provider, ctx.model)?.thinking && usableModelInfo(provider, ctx.model)?.thinking !== 'off')) generationConfig.thinkingConfig = thinkingConfig
  const fmt = req.responseFormat?.trim().toLowerCase()
  if (fmt === 'json' || fmt === 'json_object' || fmt === 'application/json') generationConfig.responseMimeType = 'application/json'

  const body: Record<string, unknown> = {
    contents: toGeminiContents(req, provider, ctx.model),
    generationConfig,
  }
  if (req.systemInstruction) body.systemInstruction = { parts: [{ text: req.systemInstruction }] }
  if (req.tools.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })),
      },
    ]
    const choice = req.toolChoice?.trim().toLowerCase()
    const mode = choice === 'none' ? 'NONE' : choice === 'required' || choice === 'any' ? 'ANY' : choice && choice !== 'auto' ? 'ANY' : undefined
    if (mode) {
      body.toolConfig = {
        functionCallingConfig: { mode, ...(mode === 'ANY' && choice && !['required', 'any'].includes(choice) ? { allowedFunctionNames: [req.toolChoice] } : {}) },
      }
    }
  }
  return body
}

function modelPath(model: string): string {
  return model.startsWith('models/') || model.startsWith('tunedModels/') ? model : `models/${model}`
}

async function* stream(req: AccioRequest, ctx: AdapterContext): AsyncGenerator<AdapterEvent> {
  const body = buildGeminiBody(req, ctx)
  ctx.onUpstreamRequest?.(body)
  const url = providerUrl(ctx.provider, `v1beta/${modelPath(ctx.model)}:streamGenerateContent?alt=sse`)
  const res = await ensureOk(
    await ctx.fetch(url, { method: 'POST', headers: headers(ctx.provider), body: JSON.stringify(body), signal: ctx.signal }),
    ctx.provider.name,
  )

  let finish: string | undefined
  let usage: Partial<Usage> | undefined
  const calls: AdapterEvent[] = []

  for await (const ev of readSse(requireBody(res), ctx.signal)) {
    const j = tryJson(ev.data) as Record<string, any> | undefined
    if (!j) continue
    if (j.candidates?.length || j.usageMetadata || j.error || j.promptFeedback) ctx.onProgress?.()
    if (j.error) throw new UpstreamError(`${ctx.provider.name}：${j.error.message ?? JSON.stringify(j.error)}`)
    if (j.promptFeedback?.blockReason) throw new UpstreamError(tr("{0}：请求被拦截（{1}）", ctx.provider.name, j.promptFeedback.blockReason))
    if (j.usageMetadata) {
      const u = j.usageMetadata
      usage = {
        usageReported: typeof u.promptTokenCount === 'number' && typeof u.candidatesTokenCount === 'number',
        cacheReadReported: typeof u.cachedContentTokenCount === 'number',
        cacheWriteReported: false,
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        cachedTokens: u.cachedContentTokenCount ?? 0,
        reasoningTokens: u.thoughtsTokenCount ?? 0,
      }
    }
    const cand = j.candidates?.[0]
    if (!cand) continue
    for (const p of cand.content?.parts ?? []) {
      const signature = wrapSignature(signatureOwner(ctx.provider, ctx.model), p.thoughtSignature)
      if (p.functionCall) {
        calls.push({
          type: 'tool_call',
          id: p.functionCall.id || newToolId(),
          name: p.functionCall.name ?? '',
          argsJson: JSON.stringify(p.functionCall.args ?? {}),
          signature,
        })
      } else if (typeof p.text === 'string') {
        // Accio only keeps a signature attached to non-empty text.
        if (p.thought) yield { type: 'thought', text: p.text || '​', signature }
        else if (p.text || signature) yield { type: 'text', text: p.text || '​', signature }
      }
    }
    if (cand.finishReason) finish = cand.finishReason
  }
  if (!finish) throw new UpstreamError(tr("{0}：响应未完整结束（缺少 finishReason），请检查接口协议或重试", ctx.provider.name))
  for (const c of calls) yield c
  if (finish && !['STOP', 'MAX_TOKENS'].includes(finish) && !calls.length) {
    yield { type: 'text', text: tr("\n\n[生成结束：{0}]", finish) }
  }
  yield { type: 'finish', reason: finish, usage }
}

async function listModels(provider: Provider, fetch: FetchLike, signal?: AbortSignal): Promise<string[]> {
  const res = await ensureOk(
    await fetch(providerUrl(provider, 'v1beta/models?pageSize=1000'), { headers: headers(provider), signal }),
    provider.name,
  )
  const j = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] }
  return (j.models ?? [])
    .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
    .map((m) => (m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean)
}

async function describeModel(provider: Provider, fetch: FetchLike, signal?: AbortSignal): Promise<ModelInfo | undefined> {
  const sourceUrl = providerUrl(provider, `v1beta/models/${encodeURIComponent(provider.model.replace(/^models\//, ''))}`)
  const response = await ensureOk(await fetch(sourceUrl, { headers: headers(provider), signal }), provider.name)
  const model = await response.json() as Record<string, unknown>
  if (typeof model.name !== 'string') return undefined
  return { model: provider.model, contextWindow: positiveTokens(model.inputTokenLimit), windowKind: 'input', maxOutputTokens: positiveTokens(model.outputTokenLimit), thinking: model.thinking === true ? (provider.model.includes('2.5') ? 'budget' : 'adaptive') : model.thinking === false ? 'off' : undefined, source: 'api', sourceUrl, checkedAt: Date.now() }
}

export const geminiAdapter: Adapter = { headers, stream, listModels, describeModel }
