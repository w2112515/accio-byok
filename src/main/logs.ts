import { tr } from '../shared/i18n.ts'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { ProviderPricing, RequestCapture, RequestLog, UsageBucket, UsageStats } from '../shared/types.ts'

const RECENT_LIMIT = 500
const CAPTURE_LIMIT = 30
const CAPTURE_BYTES = 16 * 1024 * 1024
const DAY_CACHE_BYTES = 16 * 1024 * 1024

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

type PricedUsage = Pick<RequestLog, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'usageReported'>

function costDetails(e: PricedUsage, pricing?: ProviderPricing): { costUsd?: number; costComplete: boolean } {
  if (!pricing || !Object.values(pricing).some((v) => v !== undefined) || e.usageReported === false) return { costComplete: false }
  const cached = Math.min(e.cachedTokens, e.inputTokens)
  const written = Math.min(e.cacheWriteTokens ?? 0, Math.max(0, e.inputTokens - cached))
  const components: [number, number | undefined][] = [
    [Math.max(0, e.inputTokens - cached - written), pricing.input],
    [cached, pricing.cachedInput ?? pricing.input],
    [written, pricing.cacheWriteInput ?? pricing.input],
    [e.outputTokens, pricing.output],
  ]
  const costComplete = components.every(([tokens, price]) => tokens === 0 || price !== undefined)
  const known = components.filter(([tokens, price]) => tokens > 0 && price !== undefined)
  return { costComplete, costUsd: known.length || costComplete ? known.reduce((sum, [tokens, price]) => sum + tokens * price!, 0) / 1_000_000 : undefined }
}

export function estimateCost(e: PricedUsage, pricing?: ProviderPricing): number | undefined {
  return costDetails(e, pricing).costUsd
}

function emptyBucket(key: string): UsageBucket {
  return { key, requests: 0, errors: 0, aborted: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, costUsd: 0, durationMs: 0, estimatedRequests: 0, fullyEstimatedRequests: 0, byokRequests: 0, cacheReportedRequests: 0, cacheReportedInputTokens: 0, cacheReportedTokens: 0 }
}

function addTo(b: UsageBucket, e: RequestLog): void {
  b.requests++
  if (e.status === 'error') b.errors++
  if (e.status === 'aborted') b.aborted = (b.aborted ?? 0) + 1
  if (e.mode === 'byok') b.byokRequests = (b.byokRequests ?? 0) + 1
  if (e.costUsd !== undefined) b.estimatedRequests = (b.estimatedRequests ?? 0) + 1
  if (e.costComplete) b.fullyEstimatedRequests = (b.fullyEstimatedRequests ?? 0) + 1
  if (e.cacheReadReported) {
    b.cacheReportedRequests = (b.cacheReportedRequests ?? 0) + 1
    b.cacheReportedInputTokens = (b.cacheReportedInputTokens ?? 0) + e.inputTokens
    b.cacheReportedTokens = (b.cacheReportedTokens ?? 0) + e.cachedTokens
  }
  b.inputTokens += e.inputTokens
  b.outputTokens += e.outputTokens
  b.cachedTokens += e.cachedTokens
  b.cacheWriteTokens = (b.cacheWriteTokens ?? 0) + (e.cacheWriteTokens ?? 0)
  b.reasoningTokens += e.reasoningTokens
  b.costUsd += e.costUsd ?? 0
  b.durationMs += e.durationMs
}

export class LogStore extends EventEmitter {
  private dir: string
  private recentEntries: RequestLog[] = []
  private captures = new Map<string, RequestCapture>()
  private captureSizes = new Map<string, number>()
  private dayCache = new Map<string, { mtime: number; size: number; entries: RequestLog[] }>()
  private writes: Promise<void> = Promise.resolve()
  private seq = 0

  constructor(dir: string) {
    super()
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
    const now = Date.now()
    for (const ts of [now - 86_400_000, now]) {
      this.recentEntries.push(...this.readDaySync(dayKey(ts)))
    }
    this.recentEntries = this.recentEntries.slice(-RECENT_LIMIT)
  }

  private file(day: string): string {
    return path.join(this.dir, `${day}.jsonl`)
  }

  private readDaySync(day: string): RequestLog[] {
    try {
      return fs
        .readFileSync(this.file(day), 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try { return [JSON.parse(l) as RequestLog] } catch { return [] }
        })
    } catch {
      return []
    }
  }

  add(entry: Omit<RequestLog, 'id' | 'costUsd'>, pricing?: ProviderPricing, capture?: Omit<RequestCapture, 'id'>): RequestLog {
    const log: RequestLog = {
      ...entry,
      id: `${entry.ts.toString(36)}-${(this.seq++).toString(36)}`,
      ...costDetails(entry, pricing),
      pricing: pricing ? { ...pricing } : undefined,
    }
    this.recentEntries.push(log)
    if (this.recentEntries.length > RECENT_LIMIT) this.recentEntries.shift()
    void this.enqueue(() => fsp.appendFile(this.file(dayKey(log.ts)), `${JSON.stringify(log)}\n`))
    if (capture) {
      const serialized = JSON.stringify(capture, (key, value) => /^(token|access_?token|refresh_?token|authorization|api_?key|cookie|secret)$/i.test(key) ? tr("[已隐藏]") : value)
      const bounded = Buffer.byteLength(serialized) <= 2 * 1024 * 1024
        ? JSON.parse(serialized) as Omit<RequestCapture, 'id'>
        : { request: tr("调试内容超过 2 MiB，未保留正文；用量日志不受影响。"), events: [] }
      this.captures.set(log.id, { id: log.id, ...bounded })
      this.captureSizes.set(log.id, Buffer.byteLength(JSON.stringify(bounded)))
      while (this.captures.size > CAPTURE_LIMIT || [...this.captureSizes.values()].reduce((a, b) => a + b, 0) > CAPTURE_BYTES) {
        const first = this.captures.keys().next().value!
        this.captures.delete(first)
        this.captureSizes.delete(first)
      }
    }
    this.emit('log', log)
    return log
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.writes.then(task)
    this.writes = operation.catch((e) => { this.emit('storage-error', e instanceof Error ? e.message : String(e)) })
    return this.writes
  }

  clearCaptures(): void {
    this.captures.clear()
    this.captureSizes.clear()
  }

  recent(limit = 200): RequestLog[] {
    return this.recentEntries.slice(-limit).reverse()
  }

  capture(id: string): RequestCapture | undefined {
    return this.captures.get(id)
  }

  private async readDay(day: string): Promise<RequestLog[]> {
    const file = this.file(day)
    const st = await fsp.stat(file).catch(() => null)
    if (!st) return []
    const cached = this.dayCache.get(day)
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.entries
    const entries = (await fsp.readFile(file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as RequestLog]
        } catch {
          return []
        }
      })
    this.dayCache.delete(day)
    if (st.size <= DAY_CACHE_BYTES) this.dayCache.set(day, { mtime: st.mtimeMs, size: st.size, entries })
    while (this.dayCache.size > 31 || [...this.dayCache.values()].reduce((sum, item) => sum + item.size, 0) > DAY_CACHE_BYTES) {
      this.dayCache.delete(this.dayCache.keys().next().value!)
    }
    return entries
  }

  async stats(days: number): Promise<UsageStats> {
    await this.writes
    days = Math.min(366, Math.max(1, Math.floor(days) || 1))
    const end = new Date()
    end.setHours(23, 59, 59, 999)
    const start = new Date(end)
    start.setDate(start.getDate() - (days - 1))
    start.setHours(0, 0, 0, 0)

    const totals = emptyBucket('total')
    const byDay: UsageBucket[] = []
    const byProvider = new Map<string, UsageBucket & { name: string }>()
    const byModel = new Map<string, UsageBucket>()
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = dayKey(d.getTime())
      const bucket = emptyBucket(key)
      for (const e of await this.readDay(key)) {
        addTo(bucket, e)
        addTo(totals, e)
        const p = byProvider.get(e.providerId) ?? { ...emptyBucket(e.providerId), name: e.providerName }
        p.name = e.providerName
        addTo(p, e)
        byProvider.set(e.providerId, p)
        const mk = e.targetModel || e.accioModel || 'unknown'
        const m = byModel.get(mk) ?? emptyBucket(mk)
        addTo(m, e)
        byModel.set(mk, m)
      }
      byDay.push(bucket)
    }
    return {
      from: start.getTime(),
      to: end.getTime(),
      totals,
      byDay,
      byProvider: [...byProvider.values()].sort((a, b) => b.requests - a.requests),
      byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests).slice(0, 12),
    }
  }

  async clear(): Promise<void> {
    const entries = new Set(this.recentEntries.map((entry) => entry.id))
    const captures = [...this.captures.keys()]
    const operation = this.writes.then(async () => {
      for (const f of await fsp.readdir(this.dir)) {
        if (f.endsWith('.jsonl')) await fsp.rm(path.join(this.dir, f), { force: true })
      }
      this.recentEntries = this.recentEntries.filter((entry) => !entries.has(entry.id))
      for (const id of captures) { this.captures.delete(id); this.captureSizes.delete(id) }
      this.dayCache.clear()
      this.emit('cleared')
    })
    this.writes = operation.catch(() => {}) // caller receives clear failures
    await operation
  }
}
