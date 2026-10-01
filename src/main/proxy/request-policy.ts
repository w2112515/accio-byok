import { createHash } from 'node:crypto'
import type { ConnectionProtection, Provider } from '../../shared/types.ts'
import { UpstreamError } from './accio.ts'
import type { FetchLike } from './adapters/common.ts'

export function redactProviderError(message: string, provider: Provider): string {
  const secrets = [provider.apiKey, ...Object.values(provider.extraHeaders ?? {}).flatMap((value) => [value, value.trim(), value.trim().match(/^(?:Bearer|Basic)\s+(.+)$/i)?.[1] ?? ''])].filter(Boolean).sort((a, b) => b.length - a.length)
  for (const value of secrets) message = message.split(value).join('[已隐藏凭据]')
  return message.slice(0, 2000)
}

/** No replay or queue: retain the selected connection and let the caller retry explicitly. */
export function protectedFetch(fetch: FetchLike, now = Date.now, onChange = () => {}): FetchLike & { inspect(url: string, init: RequestInit): ConnectionProtection } {
  const states = new Map<string, { active: number; until: number }>()
  const connectionKey = (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    const auth = [...headers].filter(([k]) => !['accept', 'content-type', 'anthropic-version', 'anthropic-beta'].includes(k)).sort(([a], [b]) => a.localeCompare(b))
    return createHash('sha256').update(JSON.stringify([new URL(url).origin, auth])).digest('hex')
  }
  const block = (message: string) => Object.assign(new UpstreamError(message, 429), { notSent: true })
  const guarded: FetchLike = async (url, init) => {
    const key = connectionKey(url, init)
    for (const [k, s] of states) if (!s.active && s.until <= now()) states.delete(k)
    let state = states.get(key)
    if (!state) {
      if (states.size >= 256) throw block('连接保护记录已满，请稍后再试；本次未发送')
      state = { active: 0, until: 0 }
      states.set(key, state)
    }
    if (state.until > now()) throw block(`上游限流冷却中，请等待 ${Math.ceil((state.until - now()) / 1000)} 秒后手动重试；未向供应商发送本次请求`)
    if (state.active >= 4) throw block('同一接入凭据已有 4 个请求进行中，请等待完成后再试；未发送本次请求')
    state.active++
    onChange()
    let released = false
    const release = () => { if (!released) { released = true; state!.active--; init.signal?.removeEventListener('abort', release); onChange() } }
    init.signal?.addEventListener('abort', release, { once: true })
    try {
      init.signal?.throwIfAborted()
      const res = await fetch(url, { ...init, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' })
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {})
        throw new UpstreamError('接口返回重定向，已阻止转发 Key 和会话；请核对并直接填写可信的最终 API 地址', res.status)
      }
      if (res.status === 429) {
        const retry = res.headers.get('retry-after')?.trim()
        const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : NaN
        const duration = Number.isFinite(seconds) ? seconds : retry ? Date.parse(retry) - now() : NaN
        state.until = now() + (Number.isFinite(duration) && duration >= 0 ? Math.max(1000, duration) : 60_000)
        onChange()
      }
      if (!res.body) { release(); return res }
      const reader = res.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read()
            if (next.done) { release(); reader.releaseLock(); controller.close() }
            else controller.enqueue(next.value)
          } catch (e) { release(); controller.error(e) }
        },
        async cancel(reason) { try { await reader.cancel(reason) } finally { release() } },
      })
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    } catch (e) {
      release()
      throw e
    }
  }
  return Object.assign(guarded, { inspect: (url: string, init: RequestInit): ConnectionProtection => {
    const state = states.get(connectionKey(url, init))
    return { active: state?.active ?? 0, limit: 4, retryAt: state && state.until > now() ? state.until : undefined }
  } })
}
