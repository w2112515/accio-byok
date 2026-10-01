import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { CapabilityCheck, Provider, TestResult } from '../shared/types.ts'
import { autoParameters, usableModelInfo } from '../shared/model-info.ts'

export function connectionFingerprint(p: Provider): string {
  if (p.parameterMode === 'auto') p = autoParameters(p) as Provider
  const { name: _name, note: _note, id: _id, createdAt: _created, pricing: _pricing, pricingModel: _pm, pricingUpdatedAt: _pt, modelInfo: _mi, fallbackEligible: _fallback, ...connection } = p
  if (connection.parameterMode !== 'auto') { delete connection.parameterMode; delete connection.reasoningPreference }
  else {
    connection.reasoningPreference ??= 'auto'
    // In auto mode metadata affects the request. Dates and prices alone do not.
    const info = usableModelInfo(p)
    Object.assign(connection, { automaticModelSettings: info ? { maxOutputTokens: info.maxOutputTokens, effortLevels: info.effortLevels, thinking: info.thinking, sampling: info.sampling, reasoningContent: info.reasoningContent, recommendedApi: info.recommendedApi } : null })
  }
  if (connection.credentialId && connection.authMode?.endsWith('-oauth')) connection.apiKey = ''
  // Older records omit defaults which the editor writes explicitly. Both forms run
  // the same request and must share evidence, including a manual recheck in the UI.
  Object.assign(connection, {
    openaiApi: connection.openaiApi ?? 'chat',
    allowInsecureHttp: connection.allowInsecureHttp ?? false,
    authMode: connection.authMode ?? 'api-key',
    fundingSource: connection.fundingSource ?? (connection.authMode === 'none' ? 'local' : connection.authMode === 'openai-oauth' || connection.authMode === 'subscription-key' ? 'subscription' : 'api'),
    subscriptionAcknowledged: connection.subscriptionAcknowledged ?? false,
    modelOverrides: connection.modelOverrides ?? {},
    sendReasoningEffort: connection.sendReasoningEffort ?? false,
    sendReasoningContent: connection.sendReasoningContent ?? false,
    thinking: connection.thinking ?? 'off',
    thinkingBudget: connection.thinkingBudget ?? 8000,
    promptCaching: connection.promptCaching ?? false,
    sendSampling: connection.sendSampling ?? false,
    extraHeaders: connection.extraHeaders ?? {},
  })
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value
  return createHash('sha256').update(JSON.stringify(canonical(connection))).digest('hex')
}

/** Evidence is produced by main-process probes, never accepted from a renderer form. */
export class ConnectionChecks {
  private file: string
  private entries: Record<string, CapabilityCheck[]> = {}
  constructor(file: string) {
    this.file = file
    try { this.entries = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* Missing or unreadable evidence means unverified, never success. */ }
  }
  get(p: Provider): CapabilityCheck[] { return this.entries[connectionFingerprint(p)] ?? [] }
  add(p: Provider, result: TestResult): void {
    if (!result.scope || !result.checkedAt) return
    const key = connectionFingerprint(p)
    const next = { ...this.entries, [key]: [...this.get(p).filter((r) => r.scope !== result.scope), result as CapabilityCheck] }
    while (Object.keys(next).length > 200) delete next[Object.keys(next)[0]]
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(next))
    fs.renameSync(`${this.file}.tmp`, this.file)
    this.entries = next
  }
}
