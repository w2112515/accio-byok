import { tr } from '../../../shared/i18n.ts'
import { createHash } from 'node:crypto'
import { UpstreamError, clampEffort, safeToolId, unwrapSignature, wrapSignature, type AccioRequest, type AdapterEvent, type Usage } from '../accio.ts'
import { readSse, tryJson } from '../sse.ts'
import { ensureOk, providerUrl, requireBody, resolveMaxTokens, type Adapter, type AdapterContext } from './common.ts'
import { openaiAdapter, openaiHeaders, responseFormat, toolChoice, toOpenAIMessages } from './openai.ts'

type Item = Record<string, any>
type Connection = Pick<AdapterContext, 'provider' | 'model'>

// Bind opaque reasoning to the exact connection/model; never replay it after switching accounts.
function signatureOwner({ provider, model }: Connection): string {
  const hash = createHash('sha256').update(JSON.stringify([provider.baseUrl, provider.apiKey, provider.extraHeaders, model])).digest('hex').slice(0, 24)
  return `${provider.id}-responses-${hash}`
}

function reasoningItem(item: Item): Item | undefined {
  if (item?.type !== 'reasoning' || typeof item.encrypted_content !== 'string' || !item.encrypted_content) return undefined
  return {
    type: 'reasoning', ...(typeof item.id === 'string' ? { id: item.id } : {}), encrypted_content: item.encrypted_content,
    summary: Array.isArray(item.summary) ? item.summary.filter((p: Item) => p.type === 'summary_text' && typeof p.text === 'string').map((p: Item) => ({ type: 'summary_text', text: p.text })) : [],
  }
}

export function buildResponsesBody(req: AccioRequest, ctx: Connection): Item {
  if (req.stopSequences.length) throw new UpstreamError(tr("Responses 接口不支持自定义停止序列，请取消该选项或使用 Chat Completions"), 400)
  const messages = toOpenAIMessages(req, ctx.provider)
  const modelTurns = req.contents.filter((c) => ['model', 'assistant'].includes(c.role) && c.parts.some((p) => p.functionCall || p.text))
  const input: Item[] = []
  let modelIndex = 0
  const seenReasoning = new Set<string>()
  for (const m of messages as Item[]) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const turn = modelTurns[modelIndex++]
      for (const p of turn?.parts ?? []) {
        const value = unwrapSignature(signatureOwner(ctx), p.functionCall?.thoughtSignature ?? p.thoughtSignature)
        if (!value || seenReasoning.has(value)) continue
        seenReasoning.add(value)
        const saved = tryJson(value)
        if (Array.isArray(saved)) for (const raw of saved) { const item = reasoningItem(raw); if (item) input.push(item) }
      }
      if (m.content) input.push({ role: 'assistant', content: m.content })
      for (const call of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
    } else {
      input.push({ role: 'user', content: typeof m.content === 'string' ? m.content : m.content.map((p: Item) => p.type === 'image_url' ? { type: 'input_image', image_url: p.image_url.url, detail: 'auto' } : { type: 'input_text', text: p.text }) })
    }
  }
  const body: Item = {
    model: ctx.model, input, stream: true, store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: resolveMaxTokens(req, ctx.provider, 16384),
  }
  if (req.systemInstruction) body.instructions = req.systemInstruction
  if (req.tools.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }))
    const choice = toolChoice(req.toolChoice) as any
    if (choice !== undefined) body.tool_choice = choice?.function?.name ? { type: 'function', name: choice.function.name } : choice
  }
  if (ctx.provider.sendSampling) {
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.topP !== undefined) body.top_p = req.topP
  }
  if (ctx.provider.sendReasoningEffort) {
    const effort = clampEffort(req.reasoningEffort, ['minimal', 'low', 'medium', 'high', 'xhigh'])
    if (effort) body.reasoning = { effort }
  }
  const format = responseFormat(req.responseFormat) as Item | undefined
  if (format) body.text = { format: format.type === 'json_schema' ? { type: 'json_schema', ...format.json_schema } : format }
  return body
}

async function* stream(req: AccioRequest, ctx: AdapterContext): AsyncGenerator<AdapterEvent> {
  const body = buildResponsesBody(req, ctx)
  ctx.onUpstreamRequest?.(body)
  const res = await ensureOk(await ctx.fetch(providerUrl(ctx.provider, 'responses'), {
    method: 'POST', headers: openaiHeaders(ctx.provider), body: JSON.stringify(body), signal: ctx.signal,
  }), ctx.provider.name)
  const items = new Map<number, Item>()
  const emitted = new Map<string, string>()
  let terminal: Item | undefined
  for await (const ev of readSse(requireBody(res), ctx.signal)) {
    if (ev.data === '[DONE]') break
    const j = tryJson(ev.data) as Item | undefined
    if (!j) continue
    const type = j.type ?? ev.event
    if (type === 'error' || type === 'response.failed') throw new UpstreamError(`${ctx.provider.name}：${j.response?.error?.message ?? j.error?.message ?? j.message ?? tr("Responses 请求失败")}`, Number(j.status_code ?? j.response?.error?.status_code) || 502)
    if (/^response\.(output_text|refusal|reasoning_summary_text)\.delta$/.test(type) && typeof j.delta === 'string') {
      ctx.onProgress?.()
      const key = `${j.item_id ?? j.output_index}:${j.content_index ?? j.summary_index ?? 0}:${type.split('.')[1]}`
      emitted.set(key, (emitted.get(key) ?? '') + j.delta)
      yield { type: type.includes('reasoning') ? 'thought' : 'text', text: j.delta }
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (j.item && Number.isInteger(j.output_index)) { items.set(j.output_index, j.item); ctx.onProgress?.() }
    } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
      const item = items.get(j.output_index)
      if (item) {
        item.arguments = type.endsWith('.done') ? j.arguments : (item.arguments ?? '') + (j.delta ?? '')
        ctx.onProgress?.()
      }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      terminal = j.response
      if (!terminal) throw new UpstreamError(tr("Responses 结束事件缺少 response"))
      if (Array.isArray(terminal.output) && terminal.output.length) terminal.output.forEach((item: Item, i: number) => items.set(i, item))
      terminal.status ??= type === 'response.completed' ? 'completed' : 'incomplete'
      break
    }
  }
  if (!terminal) throw new UpstreamError(tr("Responses 响应未完整结束；已停止本轮，未执行工具调用"))
  const output = [...items.entries()].sort(([a], [b]) => a - b)
  const u = terminal.usage ?? {}
  const usage: Partial<Usage> = {
    usageReported: typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number',
    cacheReadReported: typeof u.input_tokens_details?.cached_tokens === 'number', cacheWriteReported: false,
    inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
    cachedTokens: u.input_tokens_details?.cached_tokens ?? 0, reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
  }
  const calls = output.map(([, item]) => item).filter((item) => item.type === 'function_call')
  if (terminal.status !== 'completed') {
    yield { type: 'finish', reason: 'length', usage }
    if (calls.length || terminal.incomplete_details?.reason !== 'max_output_tokens') throw new UpstreamError(tr("Responses 未完成（{0}）；未执行工具调用", terminal.incomplete_details?.reason ?? terminal.status))
  }
  const reasoning = output.map(([, item]) => reasoningItem(item)).filter(Boolean)
  const signature = reasoning.length ? wrapSignature(signatureOwner(ctx), JSON.stringify(reasoning)) : undefined
  for (const [index, item] of output) {
    const parts = item.type === 'reasoning' ? item.summary : item.content
    for (const [i, part] of (Array.isArray(parts) ? parts : []).entries()) {
      const kind = part.type === 'summary_text' ? 'reasoning_summary_text' : part.type
      if (!['output_text', 'refusal', 'reasoning_summary_text'].includes(kind)) continue
      const text = String(part.text ?? part.refusal ?? '')
      const previous = emitted.get(`${item.id ?? index}:${i}:${kind}`) ?? ''
      const tail = text.startsWith(previous) ? text.slice(previous.length) : previous ? '' : text
      if (tail) yield { type: kind === 'reasoning_summary_text' ? 'thought' : 'text', text: tail }
    }
  }
  // Accio preserves signatures only on non-empty parts; reuse the existing invisible placeholder.
  if (signature) yield { type: 'thought', text: '\u200b', signature }
  for (const call of calls) {
    if (!call.call_id || !call.name || typeof call.arguments !== 'string' || (call.status && call.status !== 'completed')) throw new UpstreamError(tr("Responses 工具调用不完整，已停止本轮"))
    yield { type: 'tool_call', id: safeToolId(call.call_id), name: call.name, argsJson: call.arguments, signature }
  }
  yield { type: 'finish', reason: terminal.status === 'completed' ? (calls.length ? 'tool_calls' : 'stop') : 'length', usage }
}

export const responsesAdapter: Adapter = { headers: openaiHeaders, stream, listModels: openaiAdapter.listModels }
