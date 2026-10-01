import { getLanguage, tr } from '../../../shared/i18n.ts'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function fmtTokens(n: number): string {
  if (!n) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`
  return n.toLocaleString(getLanguage())
}

export function fmtNumber(n: number): string {
  return n.toLocaleString(getLanguage())
}

export function fmtCost(usd: number | undefined): string {
  if (usd === undefined || usd === null) return '—'
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${usd.toFixed(0)}`
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function timeAgo(ts: number | undefined): string {
  if (!ts) return '—'
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 5) return tr("刚刚")
  if (s < 60) return tr("{0} 秒前", s)
  const m = Math.round(s / 60)
  if (m < 60) return tr("{0} 分钟前", m)
  const h = Math.round(m / 60)
  if (h < 24) return tr("{0} 小时前", h)
  const d = Math.round(h / 24)
  return d < 30 ? tr("{0} 天前", d) : new Date(ts).toLocaleDateString(getLanguage())
}

export function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString(getLanguage(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(getLanguage(), { hour12: false })
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
