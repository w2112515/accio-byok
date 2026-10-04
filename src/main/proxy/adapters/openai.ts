import { tr } from '../../../shared/i18n.ts'
import type { ModelInfo, Provider } from '../../../shared/types.ts'
import { autoEffort } from '../../../shared/model-info.ts'
import { REASONING_EFFORTS } from '../../../shared/types.ts'
import {
  UpstreamError,
  clampEffort,
  newToolId,
  safeToolId,
  toolResultText,
  type AccioRequest,
  type AdapterEvent,
  type Usage,
} from '../accio.ts'
import { readSse, tryJson } from '../sse.ts'
import {
  IMAGE_MIME,
  ThinkTagSplitter,
  ensureOk,
  hostOf,
  isHttpUrl,
  mergeHeaders,
  providerUrl,
  positiveTokens,
  requireBody,
  resolveMaxTokens,
  type Adapter,
  type AdapterContext,
  type FetchLike,
} from './common.ts'

type Msg = Record<string, unknown>
type ContentItem = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export function openaiHeaders(provider: Provider): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
  if (provider.apiKey) h.Authorization = `Bearer ${provider.apiKey}`
  if (hostOf(provider.baseUrl) === 'openrouter.ai') {
    h['X-Title'] = 'Accio BYOK'
  }
  return mergeHeaders(h, provider.extraHeaders)
}

function userContent(items: ContentItem[]): string | ContentItem[] {
  return items.every((i) => i.type === 'text') ? items.map((i) => (i as { text: string }).text).join('\n') : items
}

export function toOpenAIMessages(req: AccioRequest, provider: Provider): Msg[] {
  const out: Msg[] = []
  if (req.systemInstruction) out.push({ role: 'system', content: req.systemInstruction })

  for (const c of req.contents) {
    if (c.role === 'model' || c.role === 'assistant') {
      let text = ''
      let reasoning = ''
      const toolCalls: Msg[] = []
      for (const p of c.parts) {
        if (p.functionCall) {
          toolCalls.push({
            id: safeToolId(p.functionCall.id || newToolId()),
            type: 'function',
            function: { name: p.functionCall.name, arguments: p.functionCall.argsJson || '{}' },
          })
        } else if (p.text) {
          if (p.thought) reasoning += p.text
          else text += p.text
        }
      }
      if (!text && !toolCalls.length && !reasoning) continue
      const m: Msg = { role: 'assistant', content: text || (toolCalls.length ? null : '') }
      if (toolCalls.length) m.tool_calls = toolCalls
      if (reasoning && provider.sendReasoningContent) m.reasoning_content = reasoning
      out.push(m)
      continue
    }

    const toolMsgs: Msg[] = []
    const items: ContentItem[] = []
    for (const p of c.parts) {
      if (p.functionResponse) {
        toolMsgs.push({
          role: 'tool',
          tool_call_id: safeToolId(p.functionResponse.id),
          content: toolResultText(p.functionResponse.responseJson) || '(empty result)',
        })
      } else if (p.inlineData?.data) {
        const mime = p.inlineData.mimeType.toLowerCase()
        if (IMAGE_MIME.has(mime)) items.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${p.inlineData.data}` } })
        // Wire-format fallback text stays stable when the display language changes.
        else items.push({ type: 'text', text: `[附件 ${mime}，当前模型接口不支持该类型]` })
      } else if (p.fileData?.fileUri) {
        const { fileUri, mimeType } = p.fileData
        const looksImage = mimeType.startsWith('image/') || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(fileUri)
        if (looksImage && (isHttpUrl(fileUri) || fileUri.startsWith('data:'))) items.push({ type: 'image_url', image_url: { url: fileUri } })
        else items.push({ type: 'text', text: `[文件] ${fileUri}` })
      } else if (p.text && !p.thought) {
        items.push({ type: 'text', text: p.text })
      }
    }
    out.push(...toolMsgs)
    if (items.length) out.push({ role: 'user', content: userContent(items) })
  }
  return repairToolPairs(out)
}

/**
 * Chat Completions requires every assistant tool call to be answered by a `tool` message
 * before the next turn, and rejects tool messages without a matching call.
 */
export function repairToolPairs(messages: Msg[]): Msg[] {
  const out: Msg[] = []
  let pending: string[] = []
  const flushPending = () => {
    for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: '(no result)' })
    pending = []
  }
  for (const m of messages) {
    if (m.role === 'tool') {
      const id = String(m.tool_call_id)
      const i = pending.indexOf(id)
      if (i >= 0) {
        pending.splice(i, 1)
        out.push(m)
      } else {
        out.push({ role: 'user', content: `[工具结果 ${id}]\n${String(m.content)}` })
      }
      continue
    }
    flushPending()
    out.push(m)
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      pending = (m.tool_calls as Msg[]).map((t) => String(t.id))
    }
  }
  flushPending()
  return out
}

export function toolChoice(choice: string | undefined): unknown {
  if (!choice) return undefined
  const c = choice.trim()
  const lower = c.toLowerCase()
  if (lower === 'auto' || lower === 'none') return lower
  if (lower === 'required' || lower === 'any') return 'required'
  if (c.startsWith('{')) {
    try {
      return JSON.parse(c)
    } catch {
      return undefined
    }
  }
  return { type: 'function', function: { name: c } }
}

export function responseFormat(fmt: string | undefined): unknown {
  if (!fmt) return undefined
  const f = fmt.trim().toLowerCase()
  if (f === 'json' || f === 'json_object' || f === 'application/json') return { type: 'json_object' }
  if (fmt.trim().startsWith('{')) {
    try {
      const v = JSON.parse(fmt)
      if (v && typeof v === 'object' && 'type' in v) return v
    } catch {
      /* ignore */
    }
  }
  return undefined
}

export function buildOpenAIBody(req: AccioRequest, ctx: Pick<AdapterContext, 'provider' | 'model'>): Record<string, unknown> {
  const { provider, model } = ctx
  const isOpenAI = hostOf(provider.baseUrl) === 'api.openai.com'
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(req, provider),
    stream: true,
    stream_options: { include_usage: true },
  }
  body[isOpenAI ? 'max_completion_tokens' : 'max_tokens'] = resolveMaxTokens(req, provider, 16384, model)
  if (isOpenAI) body.store = false
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    const tc = toolChoice(req.toolChoice)
    if (tc !== undefined) body.tool_choice = tc
  }
  if (provider.sendSampling) {
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.topP !== undefined) body.top_p = req.topP
  }
  if (req.stopSequences.length) body.stop = req.stopSequences.slice(0, 4)
  if (provider.sendReasoningEffort) {
    const effort = provider.parameterMode === 'auto' ? autoEffort(provider, model) : clampEffort(req.reasoningEffort, isOpenAI ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'])
    if (effort) {
      if (provider.parameterMode === 'auto' && hostOf(provider.baseUrl) === 'openrouter.ai') body.reasoning = { effort }
      else body.reasoning_effort = effort
    }
  }
  const rf = responseFormat(req.responseFormat)
  if (rf) body.response_format = rf
  return body
}

interface PendingCall {
  id: string
  name: string
  args: string
}

async function* stream(req: AccioRequest, ctx: AdapterContext): AsyncGenerator<AdapterEvent> {
  const body = buildOpenAIBody(req, ctx)
  ctx.onUpstreamRequest?.(body)
  const res = await ensureOk(
    await ctx.fetch(providerUrl(ctx.provider, 'chat/completions'), {
      method: 'POST',
      headers: openaiHeaders(ctx.provider),
      body: JSON.stringify(body),
      signal: ctx.signal,
    }),
    ctx.provider.name,
  )

  const calls = new Map<number, PendingCall>()
  const splitter = new ThinkTagSplitter()
  let finish: string | undefined
  let usage: Partial<Usage> | undefined

  for await (const ev of readSse(requireBody(res), ctx.signal)) {
    if (ev.data === '[DONE]') break
    const j = tryJson(ev.data) as Record<string, any> | undefined
    if (!j) continue
    if (j.usage || j.choices?.length || j.error) ctx.onProgress?.()
    if (j.error) {
      const msg = typeof j.error === 'string' ? j.error : j.error.message ?? JSON.stringify(j.error)
      throw new UpstreamError(`${ctx.provider.name}：${msg}`)
    }
    if (j.usage) {
      const u = j.usage
      usage = {
        usageReported: typeof (u.prompt_tokens ?? u.input_tokens) === 'number' && typeof (u.completion_tokens ?? u.output_tokens) === 'number',
        cacheReadReported: typeof (u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens) === 'number',
        cacheWriteReported: false,
        inputTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
        outputTokens: u.completion_tokens ?? u.output_tokens ?? 0,
        cachedTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
      }
    }
    const choice = j.choices?.[0]
    if (!choice) continue
    const d = choice.delta ?? {}
    const reasoning = typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : ''
    if (reasoning) yield { type: 'thought', text: reasoning }
    if (typeof d.content === 'string' && d.content) {
      for (const e of splitter.push(d.content)) yield e
    }
    if (Array.isArray(d.tool_calls)) {
      d.tool_calls.forEach((tc: Record<string, any>, pos: number) => {
        const index = typeof tc.index === 'number' ? tc.index : pos
        const cur = calls.get(index) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments
        else if (tc.function?.arguments && typeof tc.function.arguments === 'object') cur.args = JSON.stringify(tc.function.arguments)
        calls.set(index, cur)
      })
    }
    if (choice.finish_reason) finish = choice.finish_reason
  }
  if (!finish) throw new UpstreamError(tr("{0}：响应未完整结束（缺少 finish_reason），请检查接口协议或重试", ctx.provider.name))
  for (const e of splitter.flush()) yield e
  for (const [, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!c.name) continue
    yield { type: 'tool_call', id: safeToolId(c.id || newToolId()), name: c.name, argsJson: c.args || '{}' }
  }
  yield { type: 'finish', reason: finish, usage }
}

async function listModels(provider: Provider, fetch: FetchLike, signal?: AbortSignal): Promise<string[]> {
  const res = await ensureOk(
    await fetch(providerUrl(provider, 'models'), { headers: openaiHeaders(provider), signal }),
    provider.name,
  )
  const j = (await res.json()) as { data?: { id?: string }[]; models?: { id?: string; name?: string; slug?: string; visibility?: string }[] }
  if (provider.authMode === 'openai-oauth') return (j.models ?? []).filter((m) => m.visibility === 'list' && m.slug).map((m) => m.slug!)
  const list = j.data ?? j.models ?? []
  return list.map((m) => m.id ?? (m as { name?: string }).name ?? '').filter(Boolean).sort()
}

/** Same endpoint and credentials as inference. Metadata is not a capability probe. */
async function describeModel(provider: Provider, fetch: FetchLike, signal?: AbortSignal): Promise<ModelInfo | undefined> {
  const base = new URL(provider.baseUrl)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) && base.pathname.replace(/\/+$/, '') === '/v1'
  const ollama = local && provider.presetId === 'ollama'
  const studio = local && provider.presetId === 'lmstudio'
  const sourceUrl = ollama ? `${base.origin}/api/ps` : studio ? `${base.origin}/api/v1/models` : providerUrl(provider, 'models')
  const response = await ensureOk(await fetch(sourceUrl, { headers: openaiHeaders(provider), signal }), provider.name)
  const payload = await response.json() as Record<string, any>
  const list = payload.data ?? payload.models
  if (!Array.isArray(list)) return undefined
  const row = list.find((m) => m && (m.id === provider.model || m.name === provider.model || m.slug === provider.model || m.key === provider.model || (studio && m.loaded_instances?.some((i: any) => i.id === provider.model))))
  if (!row) return undefined
  const info: ModelInfo = { model: provider.model, windowKind: 'context', source: 'api', sourceUrl, checkedAt: Date.now() }
  if (ollama) {
    info.contextWindow = positiveTokens(row.context_length)
  } else if (studio) {
    const instances = Array.isArray(row.loaded_instances) ? row.loaded_instances : []
    const instance = instances.find((i: any) => i.id === provider.model) ?? (instances.length === 1 ? instances[0] : undefined)
    info.contextWindow = positiveTokens(instance?.config?.context_length)
    info.tools = typeof row.capabilities?.trained_for_tool_use === 'boolean' ? row.capabilities.trained_for_tool_use : undefined
    info.vision = typeof row.capabilities?.vision === 'boolean' ? row.capabilities.vision : undefined
    // A downloaded model's max_context_length is not its currently loaded window.
  } else {
    info.contextWindow = positiveTokens(row.context_window ?? row.context_length ?? row.top_provider?.context_length)
    info.maxOutputTokens = positiveTokens(row.max_output_tokens ?? row.top_provider?.max_completion_tokens)
    const params = Array.isArray(row.supported_parameters) ? row.supported_parameters : undefined
    if (params) { info.tools = params.includes('tools'); info.sampling = params.includes('temperature') && params.includes('top_p') }
    const modalities = row.input_modalities ?? row.architecture?.input_modalities
    if (Array.isArray(modalities)) info.vision = modalities.includes('image')
    const levels = row.effort?.supported_levels
    if (Array.isArray(levels)) info.effortLevels = REASONING_EFFORTS.filter((v) => levels.includes(v))
    if (base.hostname === 'openrouter.ai' && row.reasoning && Object.hasOwn(row.reasoning, 'supported_efforts')) {
      const levels = row.reasoning.supported_efforts
      if (levels === null) info.effortLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
      else if (Array.isArray(levels)) info.effortLevels = REASONING_EFFORTS.filter((v) => levels.includes(v))
    }
  }
  return Object.keys(info).some((key) => !['model', 'windowKind', 'source', 'sourceUrl', 'checkedAt'].includes(key) && info[key as keyof ModelInfo] !== undefined) ? info : undefined
}

export const openaiAdapter: Adapter = { headers: openaiHeaders, stream, listModels, describeModel }
