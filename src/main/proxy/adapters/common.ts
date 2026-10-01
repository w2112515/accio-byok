import { tr } from '../../../shared/i18n.ts'
import type { ModelInfo, Provider } from '../../../shared/types.ts'
import { createHash } from 'node:crypto'
import { normalizeBaseUrl } from '../../../shared/provider-input.ts'
import { UpstreamError, type AccioRequest, type AdapterEvent } from '../accio.ts'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export function mergeHeaders(base: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const headers = new Headers(base)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return Object.fromEntries(headers)
}

/** A saved record can change backend; opaque signatures belong to the exact connection. */
export function signatureOwner(provider: Provider, model: string): string {
  const headers = Object.entries(provider.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v]).sort(([a], [b]) => a.localeCompare(b))
  const hash = createHash('sha256').update(JSON.stringify([provider.kind, provider.baseUrl, provider.apiKey, headers, model])).digest('hex').slice(0, 24)
  return `${provider.id}-${provider.kind}-${hash}`
}

export interface AdapterContext {
  /** Provider with a decrypted API key. */
  provider: Provider
  model: string
  fetch: FetchLike
  signal: AbortSignal
  /** Debug capture of the translated upstream request. */
  onUpstreamRequest?: (body: unknown) => void
  onProgress?: () => void
}

export interface Adapter {
  headers(provider: Provider): Record<string, string>
  stream(req: AccioRequest, ctx: AdapterContext): AsyncGenerator<AdapterEvent>
  listModels(provider: Provider, fetch: FetchLike, signal?: AbortSignal): Promise<string[]>
  describeModel?(provider: Provider, fetch: FetchLike, signal?: AbortSignal): Promise<ModelInfo | undefined>
}

export const positiveTokens = (n: unknown): number | undefined => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export function providerUrl(provider: Provider, path: string): string {
  return joinUrl(normalizeBaseUrl(provider.kind, provider.baseUrl), path)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Effective max output tokens: a provider-level value overrides what Accio asked for. */
export function resolveMaxTokens(req: AccioRequest, provider: Provider, fallback: number): number {
  const v = provider.maxOutputTokens || req.maxOutputTokens || fallback
  return Math.max(1, Math.round(v))
}

function extractErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text)
    const e = Array.isArray(j) ? j[0]?.error ?? j[0] : j?.error ?? j
    if (typeof e === 'string') return e
    if (e && typeof e === 'object') {
      const msg = (e as Record<string, unknown>).message ?? (e as Record<string, unknown>).msg ?? (e as Record<string, unknown>).detail
      if (typeof msg === 'string') return msg
    }
    if (typeof j?.message === 'string') return j.message
  } catch {
    /* not JSON */
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 500)
}

export async function ensureOk(res: Response, label: string): Promise<Response> {
  if (res.ok) return res
  let text = ''
  const reader = res.body?.getReader()
  if (reader) {
    const decoder = new TextDecoder()
    try {
      while (text.length < 65536) {
        const next = await reader.read()
        if (next.done) break
        text += decoder.decode(next.value, { stream: true }).slice(0, 65536 - text.length)
      }
    } catch { /* status still provides the actionable error */ }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  const msg = (extractErrorMessage(text) || res.statusText).slice(0, 1500)
  const hint =
    res.status === 401 || res.status === 403
      ? tr("（API Key 无效或无权限）")
      : res.status === 404
        ? tr("（接口地址或模型名可能不正确）")
        : res.status === 429
          ? tr("（触发限流或余额不足）")
          : ''
  let code: string | undefined
  try { const value = JSON.parse(text)?.error?.code; if (typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value)) code = value } catch { /* Nonstandard responses still retain their diagnostic text and HTTP status. */ }
  throw Object.assign(new UpstreamError(tr("{0} 返回 {1}{2}：{3}", label, res.status, hint, msg), res.status), { code, requestId: res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? undefined })
}

export function requireBody(res: Response): ReadableStream<Uint8Array> {
  if (!res.body) throw new UpstreamError(tr("上游响应没有内容"))
  return res.body
}

/** Splits `<think>…</think>` reasoning that some local/open models emit inline. */
export class ThinkTagSplitter {
  private mode: 'detect' | 'think' | 'text' = 'detect'
  private buf = ''

  push(chunk: string): AdapterEvent[] {
    if (this.mode === 'text') return chunk ? [{ type: 'text', text: chunk }] : []
    this.buf += chunk
    const out: AdapterEvent[] = []
    if (this.mode === 'detect') {
      const trimmed = this.buf.trimStart()
      if (trimmed.startsWith('<think>')) {
        this.mode = 'think'
        this.buf = trimmed.slice('<think>'.length)
      } else if ('<think>'.startsWith(trimmed)) {
        return out
      } else {
        this.mode = 'text'
        const text = this.buf
        this.buf = ''
        return text ? [{ type: 'text', text }] : []
      }
    }
    // think mode
    const end = this.buf.indexOf('</think>')
    if (end >= 0) {
      const thought = this.buf.slice(0, end)
      const rest = this.buf.slice(end + '</think>'.length).replace(/^\s+/, '')
      this.buf = ''
      this.mode = 'text'
      if (thought) out.push({ type: 'thought', text: thought })
      if (rest) out.push({ type: 'text', text: rest })
      return out
    }
    const keep = '</think>'.length - 1
    if (this.buf.length > keep) {
      out.push({ type: 'thought', text: this.buf.slice(0, this.buf.length - keep) })
      this.buf = this.buf.slice(this.buf.length - keep)
    }
    return out
  }

  flush(): AdapterEvent[] {
    const rest = this.buf
    this.buf = ''
    if (!rest) return []
    return [{ type: this.mode === 'think' ? 'thought' : 'text', text: rest }]
  }
}

export const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])

export function isHttpUrl(u: string): boolean {
  return /^https?:\/\//i.test(u)
}
