import type { ModelInfo, Provider } from '../../../shared/types.ts'
import {
  UpstreamError,
  clampEffort,
  newToolId,
  parseArgs,
  safeToolId,
  toolResultText,
  unwrapSignature,
  wrapSignature,
  type AccioRequest,
  type AdapterEvent,
  type Usage,
} from '../accio.ts'
import { readSse, tryJson } from '../sse.ts'
import {
  IMAGE_MIME,
  ensureOk,
  hostOf,
  isHttpUrl,
  mergeHeaders,
  providerUrl,
  positiveTokens,
  requireBody,
  resolveMaxTokens,
  signatureOwner,
  type Adapter,
  type AdapterContext,
  type FetchLike,
} from './common.ts'

type Block = Record<string, unknown> & { type: string }
interface Message {
  role: 'user' | 'assistant'
  content: Block[]
}

const BINDING_BETA = 'thinking-binding-controls-2026-08-01'
/** Stands in for an empty (display: omitted) thinking text so Accio keeps the signature. */
const EMPTY_THINKING = '​'

function isOfficial(provider: Provider): boolean {
  return hostOf(provider.baseUrl) === 'api.anthropic.com'
}

function headers(provider: Provider, betas: string[] = []): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
  }
  if (provider.apiKey) h['x-api-key'] = provider.apiKey
  if (betas.length) h['anthropic-beta'] = betas.join(',')
  return mergeHeaders(h, provider.extraHeaders)
}

function mergeRoles(messages: Message[]): Message[] {
  const out: Message[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content.push(...m.content)
    else out.push({ role: m.role, content: [...m.content] })
  }
  for (const m of out) {
    if (m.role === 'user') {
      // tool_result blocks must lead the user turn.
      m.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'))
    }
  }
  return out
}

/** Every tool_use needs a tool_result in the following user turn, and vice versa. */
function repairToolPairs(messages: Message[]): Message[] {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const next = messages[i + 1]
    const ids = m.role === 'assistant' ? m.content.filter((b) => b.type === 'tool_use').map((b) => String(b.id)) : []
    if (m.role === 'user') {
      const prev = messages[i - 1]
      const allowed = new Set(prev?.role === 'assistant' ? prev.content.filter((b) => b.type === 'tool_use').map((b) => String(b.id)) : [])
      m.content = m.content.map((b) =>
        b.type === 'tool_result' && !allowed.has(String(b.tool_use_id))
          ? { type: 'text', text: `[工具结果 ${String(b.tool_use_id)}]\n${typeof b.content === 'string' ? b.content : JSON.stringify(b.content)}` }
          : b,
      )
    }
    if (!ids.length) continue
    if (!next || next.role !== 'user') {
      messages.splice(i + 1, 0, { role: 'user', content: [] })
    }
    const target = messages[i + 1]
    const have = new Set(target.content.filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id)))
    const missing = ids.filter((id) => !have.has(id)).map((id): Block => ({ type: 'tool_result', tool_use_id: id, content: '(no result)' }))
    target.content.unshift(...missing)
  }
  return messages.filter((m) => m.content.length > 0)
}

export function toAnthropicMessages(req: AccioRequest, provider: Provider, model = provider.model): Message[] {
  const messages: Message[] = []
  for (const c of req.contents) {
    const blocks: Block[] = []
    if (c.role === 'model' || c.role === 'assistant') {
      for (const p of c.parts) {
        if (p.functionCall) {
          blocks.push({ type: 'tool_use', id: safeToolId(p.functionCall.id || newToolId()), name: p.functionCall.name, input: parseArgs(p.functionCall.argsJson) })
        } else if (p.thought) {
          const sig = unwrapSignature(signatureOwner(provider, model), p.thoughtSignature)
          // Only thinking blocks this provider produced can be replayed.
          if (sig) blocks.push({ type: 'thinking', thinking: p.text === EMPTY_THINKING ? '' : p.text ?? '', signature: sig })
        } else if (p.text) {
          blocks.push({ type: 'text', text: p.text })
        }
      }
      if (blocks.length) messages.push({ role: 'assistant', content: blocks })
      continue
    }
    for (const p of c.parts) {
      if (p.functionResponse) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: safeToolId(p.functionResponse.id),
          content: toolResultText(p.functionResponse.responseJson) || '(empty result)',
        })
      } else if (p.inlineData?.data) {
        const mime = p.inlineData.mimeType.toLowerCase().replace('image/jpg', 'image/jpeg')
        if (IMAGE_MIME.has(mime)) blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: p.inlineData.data } })
        else if (mime === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: mime, data: p.inlineData.data } })
        else blocks.push({ type: 'text', text: `[附件 ${mime}，当前模型接口不支持该类型]` })
      } else if (p.fileData?.fileUri) {
        const { fileUri, mimeType } = p.fileData
        const looksImage = mimeType.startsWith('image/') || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(fileUri)
        if (looksImage && isHttpUrl(fileUri)) blocks.push({ type: 'image', source: { type: 'url', url: fileUri } })
        else blocks.push({ type: 'text', text: `[文件] ${fileUri}` })
      } else if (p.text && !p.thought) {
        blocks.push({ type: 'text', text: p.text })
      }
    }
    if (blocks.length) messages.push({ role: 'user', content: blocks })
  }

  let out = repairToolPairs(mergeRoles(messages))
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] })
  // Newer models reject assistant prefill: the conversation must end on a user turn.
  if (out[out.length - 1].role === 'assistant') out.push({ role: 'user', content: [{ type: 'text', text: '(continue)' }] })
  out = mergeRoles(out)
  return out
}

export function buildAnthropicRequest(
  req: AccioRequest,
  ctx: Pick<AdapterContext, 'provider' | 'model'>,
): { body: Record<string, unknown>; betas: string[] } {
  const { provider, model } = ctx
  const betas: string[] = []
  const body: Record<string, unknown> = {
    model,
    messages: toAnthropicMessages(req, provider, model),
    max_tokens: resolveMaxTokens(req, provider, 32000),
    stream: true,
  }
  if (req.systemInstruction) {
    body.system = provider.promptCaching
      ? [{ type: 'text', text: req.systemInstruction, cache_control: { type: 'ephemeral' } }]
      : req.systemInstruction
  }
  if (provider.promptCaching) body.cache_control = { type: 'ephemeral' }
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: 'object', ...t.parameters },
    }))
    const choice = req.toolChoice?.trim().toLowerCase()
    // Forced tool use (any/tool) is rejected by current models; steer with auto instead.
    if (choice === 'none') body.tool_choice = { type: 'none' }
    else if (choice) body.tool_choice = { type: 'auto' }
  }

  const mode = provider.thinking ?? 'off'
  if (mode === 'adaptive') {
    const thinking: Record<string, unknown> = { type: 'adaptive', display: 'summarized' }
    if (isOfficial(provider)) {
      // Accio rewrites/compacts history; degrade (drop stale thinking) instead of a 400.
      thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' }
      betas.push(BINDING_BETA)
    }
    body.thinking = thinking
  } else if (mode === 'budget') {
    const budget = Math.max(1024, provider.thinkingBudget ?? 8000)
    body.thinking = { type: 'enabled', budget_tokens: budget }
    if ((body.max_tokens as number) <= budget) body.max_tokens = budget + 4096
  }

  if (provider.sendReasoningEffort) {
    const effort = clampEffort(req.reasoningEffort, ['low', 'medium', 'high', 'xhigh', 'max'])
    if (effort) body.output_config = { effort }
  }
  // Sampling parameters are rejected by current models and by any model while thinking.
  if (provider.sendSampling && mode === 'off') {
    if (req.temperature !== undefined) body.temperature = req.temperature
    else if (req.topP !== undefined) body.top_p = req.topP
  }
  if (req.stopSequences.length) body.stop_sequences = req.stopSequences
  return { body, betas }
}

interface BlockState {
  type: string
  text: string
  signature?: string
  id?: string
  name?: string
  json: string
  input?: unknown
}

async function* stream(req: AccioRequest, ctx: AdapterContext): AsyncGenerator<AdapterEvent> {
  const { body, betas } = buildAnthropicRequest(req, ctx)
  ctx.onUpstreamRequest?.(body)
  const res = await ensureOk(
    await ctx.fetch(providerUrl(ctx.provider, 'v1/messages'), {
      method: 'POST',
      headers: headers(ctx.provider, betas),
      body: JSON.stringify(body),
      signal: ctx.signal,
    }),
    ctx.provider.name,
  )

  const blocks = new Map<number, BlockState>()
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
  let stop: string | undefined
  let completed = false
  let uncached = 0
  let created = 0
  let cached = 0
  let inputReported = false
  let outputReported = false
  const updateUsage = (u: Record<string, number>) => {
    if (typeof u.input_tokens === 'number') inputReported = true
    if (typeof u.output_tokens === 'number') outputReported = true
    usage.usageReported = inputReported && outputReported
    if (typeof u.cache_read_input_tokens === 'number') usage.cacheReadReported = true
    if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWriteReported = true
    uncached = u.input_tokens ?? uncached
    cached = u.cache_read_input_tokens ?? cached
    created = u.cache_creation_input_tokens ?? created
    usage.inputTokens = uncached + cached + created
    usage.cachedTokens = cached
    usage.cacheWriteTokens = created
    usage.outputTokens = u.output_tokens ?? usage.outputTokens
  }

  for await (const ev of readSse(requireBody(res), ctx.signal)) {
    const j = tryJson(ev.data) as Record<string, any> | undefined
    if (!j) continue
    if (['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'error'].includes(j.type)) ctx.onProgress?.()
    switch (j.type) {
      case 'message_start': {
        const u = j.message?.usage ?? {}
        updateUsage(u)
        break
      }
      case 'content_block_start': {
        const b = j.content_block ?? {}
        blocks.set(j.index, { type: b.type, text: b.thinking ?? '', id: b.id, name: b.name, json: '', input: b.input, signature: b.signature })
        if (b.type === 'text' && b.text) yield { type: 'text', text: b.text }
        break
      }
      case 'content_block_delta': {
        const st = blocks.get(j.index)
        const d = j.delta ?? {}
        if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text }
        else if (d.type === 'thinking_delta' && st) st.text += d.thinking ?? ''
        else if (d.type === 'signature_delta' && st) st.signature = d.signature
        else if (d.type === 'input_json_delta' && st) st.json += d.partial_json ?? ''
        break
      }
      case 'content_block_stop': {
        const st = blocks.get(j.index)
        if (!st) break
        if (st.type === 'thinking') {
          // Emit the whole block at once so text and signature stay paired for replay.
          const signature = wrapSignature(signatureOwner(ctx.provider, ctx.model), st.signature)
          if (st.text || signature) yield { type: 'thought', text: st.text || EMPTY_THINKING, signature }
        } else if (st.type === 'tool_use') {
          yield { type: 'tool_call', id: safeToolId(st.id || newToolId()), name: st.name ?? '', argsJson: st.json || JSON.stringify(st.input ?? {}) }
        }
        blocks.delete(j.index)
        break
      }
      case 'message_delta': {
        if (j.delta?.stop_reason) stop = j.delta.stop_reason
        if (j.usage) updateUsage(j.usage)
        break
      }
      case 'message_stop': completed = true; break
      case 'error': {
        const e = j.error ?? {}
        throw new UpstreamError(`${ctx.provider.name}：${e.type ? `${e.type} · ` : ''}${e.message ?? '未知错误'}`)
      }
    }
  }
  if (!completed || !stop || blocks.size) throw new UpstreamError(`${ctx.provider.name}：响应未完整结束，请重试`)
  if (stop === 'refusal') yield { type: 'text', text: '\n\n[模型拒绝了本次请求]' }
  yield { type: 'finish', reason: stop, usage }
}

async function listModels(provider: Provider, fetch: FetchLike, signal?: AbortSignal): Promise<string[]> {
  const res = await ensureOk(
    await fetch(providerUrl(provider, 'v1/models?limit=1000'), { headers: headers(provider, []), signal }),
    provider.name,
  )
  const j = (await res.json()) as { data?: { id?: string }[] }
  return (j.data ?? []).map((m) => m.id ?? '').filter(Boolean)
}

async function describeModel(provider: Provider, fetch: FetchLike, signal?: AbortSignal): Promise<ModelInfo | undefined> {
  const sourceUrl = providerUrl(provider, `v1/models/${encodeURIComponent(provider.model)}`)
  const response = await ensureOk(await fetch(sourceUrl, { headers: headers(provider, []), signal }), provider.name)
  const model = await response.json() as Record<string, any>
  if (typeof model.id !== 'string') return undefined
  const capabilities = model.capabilities
  return {
    model: provider.model, contextWindow: positiveTokens(model.max_input_tokens), windowKind: 'input', maxOutputTokens: positiveTokens(model.max_tokens),
    vision: typeof capabilities?.image_input?.supported === 'boolean' ? capabilities.image_input.supported : undefined,
    thinking: capabilities?.thinking?.types?.adaptive?.supported === true ? 'adaptive' : capabilities?.thinking?.types?.enabled?.supported === true ? 'budget' : undefined,
    source: 'api', sourceUrl, checkedAt: Date.now(),
  }
}

export const anthropicAdapter: Adapter = { headers, stream, listModels, describeModel }
