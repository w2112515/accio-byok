import { tr } from '../../shared/i18n.ts'
import type { Provider, RequestStatus } from '../../shared/types.ts'
import { normalizeProviderInput } from '../../shared/provider-input.ts'
import {
  emptyUsage,
  errorFrame,
  finalFrame,
  normalizeFinishReason,
  sseData,
  textFrame,
  type AccioFunctionCall,
  type AccioRequest,
  type Usage,
} from './accio.ts'
import { anthropicAdapter } from './adapters/anthropic.ts'
import type { Adapter, FetchLike } from './adapters/common.ts'
import { geminiAdapter } from './adapters/gemini.ts'
import { openaiAdapter } from './adapters/openai.ts'
import { redactProviderError } from './request-policy.ts'
import { responsesAdapter } from './adapters/responses.ts'
import { autoEffort, autoParameters } from '../../shared/model-info.ts'

export const ADAPTERS: Record<Provider['kind'], Adapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
}

export function resolveTargetModel(provider: Provider, accioModel: string): string {
  return provider.modelOverrides?.[accioModel]?.trim() || provider.model.trim()
}

export interface ByokOptions {
  req: AccioRequest
  provider: Provider
  model: string
  fetch: FetchLike
  signal: AbortSignal
  write: (chunk: string) => void
  onUpstreamRequest?: (body: unknown) => void
  onFrame?: (frame: string) => void
  headerTimeoutMs?: number
  idleTimeoutMs?: number
}

export interface ByokResult {
  status: RequestStatus
  usage: Usage
  toolCalls: number
  finishReason?: string
  ttftMs?: number
  error?: string
  httpStatus?: number
  notSent?: boolean
  errorCode?: string
  requestId?: string
}

/** Run one BYOK turn and stream it to Accio as ADK frames. Never throws. */
export async function streamByok(opts: ByokOptions): Promise<ByokResult> {
  const started = Date.now()
  const calls: AccioFunctionCall[] = []
  const seen = new Set<string>()
  const usage = emptyUsage()
  let finish: string | undefined
  let ttftMs: number | undefined
  let hasText = false
  let requestId: string | undefined
  let sent = false
  const controller = new AbortController()
  const cancel = () => controller.abort(opts.signal.reason)
  opts.signal.addEventListener('abort', cancel, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeoutMessage: string | undefined
  const arm = (ms: number, phase: string) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timeoutMessage = tr("{0}超过 {1} 秒，已停止等待；{2}，供应商可能已计费。请检查网络或在设置中调整无进展等待时间，再手动重试。", phase, Math.round(ms / 1000), ttftMs === undefined ? tr("尚无可见输出") : tr("已收到部分输出"))
      controller.abort(new Error(timeoutMessage))
    }, ms)
  }
  const progress = () => arm(opts.idleTimeoutMs ?? 180_000, tr("模型没有新进展"))

  const emit = (frame: unknown) => {
    const chunk = sseData(frame)
    opts.onFrame?.(chunk)
    opts.write(chunk)
  }

  // Utility calls (titles, summaries…) join every text part of the result, thoughts included,
  // and never ask for thoughts; only surface reasoning when the caller wants it.
  const showThoughts = opts.req.includeThoughts === true || (opts.req.includeThoughts !== false && opts.req.tools.length > 0)

  try {
    opts.signal.throwIfAborted()
    // Revalidate stored configurations too: legacy headers/HTTP cannot bypass the editor guard.
    const normalized = normalizeProviderInput(opts.provider, true)
    opts = { ...opts, provider: { ...opts.provider, ...normalized, apiKey: opts.provider.apiKey } }
    opts.provider = autoParameters(opts.provider, opts.model) as Provider
    // Validate even when unknown capabilities disable the adapter's effort field.
    autoEffort(opts.provider, opts.model)
    if (!opts.model) throw Object.assign(new Error(tr("「{0}」还没有设置模型，请在 Accio BYOK 中填写", opts.provider.name)), { status: 400 })
    const adapter = opts.provider.kind === 'openai' && opts.provider.openaiApi === 'responses' ? responsesAdapter : ADAPTERS[opts.provider.kind]
    for await (const ev of adapter.stream(opts.req, {
      provider: opts.provider,
      model: opts.model,
      fetch: async (url, init) => {
        arm(opts.headerTimeoutMs ?? 60_000, tr("等待供应商响应"))
        const response = await opts.fetch(url, { ...init, signal: controller.signal })
        sent = true
        requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined
        progress()
        return response
      },
      signal: controller.signal,
      onProgress: progress,
      onUpstreamRequest: opts.onUpstreamRequest,
    })) {
      if (ev.type === 'text' || ev.type === 'thought') {
        if (!ev.text || (ev.type === 'thought' && !showThoughts)) continue
        if (ev.type === 'text' && ev.text.replace(/[\s\u200b]/g, '')) hasText = true
        ttftMs ??= Date.now() - started
        emit(textFrame(ev.text, ev.type === 'thought', ev.signature))
      } else if (ev.type === 'tool_call') {
        ttftMs ??= Date.now() - started
        let args: unknown
        try { args = JSON.parse(ev.argsJson || '{}') } catch { throw new Error(tr("工具 {0} 的参数不完整，已停止本轮；请重试或提高最大输出 Token", ev.name)) }
        if (!ev.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error(tr("上游返回了无效的工具调用，已停止本轮"))
        let id = ev.id
        let suffix = 1
        while (seen.has(id)) id = `${ev.id}_${suffix++}`
        seen.add(id)
        calls.push({ id, name: ev.name, argsJson: ev.argsJson, thoughtSignature: ev.signature })
      } else if (ev.type === 'finish') {
        finish = ev.reason ?? finish
        if (ev.usage) Object.assign(usage, Object.fromEntries(Object.entries(ev.usage).filter(([, v]) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v) && v >= 0))))
      }
    }
    controller.signal.throwIfAborted()
    const reason = normalizeFinishReason(finish)
    if (calls.length && !['stop', 'end_turn', 'tool_calls', 'tool_use', 'function_call'].includes(finish?.toLowerCase() ?? '')) {
      throw new Error(tr("模型未正常完成工具调用（{0}），本轮工具均未交付；请检查输出上限或错误原因后手动重试", finish ?? tr("未知结束原因")))
    }
    if (!hasText && !calls.length) throw new Error(tr("模型未返回可用的正文或工具调用（{0}）；本轮为空结果，未自动重试，供应商可能已计费", finish ?? tr("未知结束原因")))
    emit(finalFrame(calls, reason, usage))
    opts.write('data: [DONE]\n\n')
    return { status: 'ok', usage, toolCalls: calls.length, finishReason: reason, ttftMs, requestId }
  } catch (err) {
    if (opts.signal.aborted) {
      return { status: 'aborted', usage, toolCalls: 0, finishReason: finish, ttftMs, error: tr("客户端已取消") }
    }
    const rawMessage = timeoutMessage ?? (err instanceof Error ? err.message : String(err))
    const message = redactProviderError(rawMessage, opts.provider)
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : undefined
    const friendly = /context.{0,30}(length|window|limit)|prompt.{0,20}(too long|too large)|too many tokens|maximum context/i.test(message)
      ? tr("{0}（目标模型上下文不足：请在 Accio 中压缩会话或新建会话，并检查最大输出 Token；切换 BYOK 不会同步修改 Accio 的压缩阈值）", message)
      : /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ERR_|network/i.test(message)
      ? tr("无法连接到「{0}」：{1}（检查网络、代理设置或接口地址）", opts.provider.name, message)
      : message
    try {
      emit(errorFrame(`[Accio BYOK] ${friendly}`, String(status && status >= 100 ? status : 502)))
    } catch {
      /* client already gone */
    }
    const code = (err as { code?: string }).code
    return { status: 'error', usage, toolCalls: 0, finishReason: finish, ttftMs, error: friendly, httpStatus: status, notSent: (err as { notSent?: boolean })?.notSent === true || (!sent && !timer), errorCode: typeof code === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(code) ? code : undefined, requestId: requestId ? redactProviderError(requestId.slice(0, 200), opts.provider) : undefined }
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', cancel)
  }
}
