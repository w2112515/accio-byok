import type { ConnectionProtection } from '../../../shared/types.ts'
import { useTicker } from '../lib/store.tsx'

/** Countdown is derived locally; rendering never makes an upstream request. */
export function ConnectionStatus({ value }: { value?: ConnectionProtection }) {
  useTicker(1000)
  if (!value) return null
  const seconds = Math.max(0, Math.ceil(((value.retryAt ?? 0) - Date.now()) / 1000))
  return <div role="status" className={`rounded-lg border px-3 py-2 text-[12px] leading-relaxed ${seconds ? 'border-warning/30 bg-warning-soft text-warning' : 'border-border text-muted'}`}>
    <p>当前并发 {value.active} / {value.limit}{seconds ? ` · 限流冷却剩余 ${seconds} 秒` : ''}</p>
    {seconds ? <p>冷却期间的新请求会在本地拦截，等待结束后手动重试。</p> : value.active >= value.limit ? <p>并发已满，请等待当前请求完成；不会自动排队或重试。</p> : null}
  </div>
}
