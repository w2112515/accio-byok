import { createHash } from 'node:crypto'
import type { ModelInfo, Provider } from '../shared/types.ts'
import { ADAPTERS } from './proxy/byok.ts'
import type { FetchLike } from './proxy/adapters/common.ts'

/** Memory only: connection-scoped, bounded, and explicitly refreshable. */
export class ModelListCache {
  private entries = new Map<string, { expires: number; models: string[] }>()
  private pending = new Map<string, Promise<string[]>>()
  private generation = 0
  private details = new Map<string, { expires: number; info: ModelInfo | undefined }>()
  private describing = new Map<string, Promise<ModelInfo | undefined>>()

  clear(): void {
    this.generation++
    this.entries.clear()
    this.pending.clear()
    this.details.clear()
    this.describing.clear()
  }

  async describe(provider: Provider, fetch: FetchLike): Promise<ModelInfo | undefined> {
    const read = ADAPTERS[provider.kind].describeModel
    if (!read) return undefined
    const key = createHash('sha256').update(JSON.stringify([provider.kind, provider.baseUrl, provider.apiKey, provider.extraHeaders, provider.model])).digest('hex')
    const cached = this.details.get(key)
    if (cached && cached.expires > Date.now()) return structuredClone(cached.info)
    const generation = this.generation
    let request = this.describing.get(key)
    if (!request) {
      request = read(provider, fetch, AbortSignal.timeout(20_000)).then((info) => {
        if (generation === this.generation) {
          this.details.set(key, { info, expires: Date.now() + 5 * 60_000 })
          while (this.details.size > 20) this.details.delete(this.details.keys().next().value!)
        }
        return info
      })
      this.describing.set(key, request)
    }
    try { return structuredClone(await request) } finally { if (this.describing.get(key) === request) this.describing.delete(key) }
  }

  async list(provider: Provider, fetch: FetchLike, refresh = false): Promise<string[]> {
    const key = createHash('sha256').update(JSON.stringify([provider.kind, provider.baseUrl, provider.apiKey, provider.extraHeaders])).digest('hex')
    const cached = this.entries.get(key)
    if (!refresh && cached && cached.expires > Date.now()) return [...cached.models]
    const pending = this.pending.get(key)
    if (pending) return [...await pending]
    const generation = this.generation
    const request = ADAPTERS[provider.kind].listModels(provider, fetch, AbortSignal.timeout(20_000)).then((list) => {
      const models = [...new Set(list.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim()))].sort()
      if (generation === this.generation) {
        this.entries.delete(key)
        this.entries.set(key, { expires: Date.now() + 5 * 60_000, models })
        while (this.entries.size > 20) this.entries.delete(this.entries.keys().next().value!)
      }
      return models
    })
    this.pending.set(key, request)
    try { return [...await request] } finally {
      if (this.pending.get(key) === request) this.pending.delete(key)
    }
  }
}
