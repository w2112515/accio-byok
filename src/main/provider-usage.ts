import { tx } from '../shared/i18n.ts'
import { usageApi } from '../shared/provider-access.ts'
import type { Provider, ProviderUsageSnapshot } from '../shared/types.ts'
import type { FetchLike } from './proxy/adapters/common.ts'

export async function readProviderUsage(p: Provider, fetch: FetchLike): Promise<ProviderUsageSnapshot> {
  const service = usageApi(p)
  if (!service || !p.apiKey) throw new Error(tx('Use this provider’s usage console; no supported usage API is configured.', '此连接没有配置支持的用量 API，请查看供应商控制台。'))
  const url = { openrouter: 'https://openrouter.ai/api/v1/key', minimax: 'https://www.minimax.io/v1/token_plan/remains', deepseek: 'https://api.deepseek.com/user/balance' }[service]
  const response = await fetch(url, { headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20_000) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Usage lookup failed (HTTP ${response.status})`) }
  const raw = await response.text()
  if (raw.length > 256_000) throw new Error(tx("Usage response is too large", "用量响应过大"))
  const data = JSON.parse(raw)
  const fields: ProviderUsageSnapshot['fields'] = []
  let note = ''
  if (service === 'openrouter') {
    for (const [key, label] of [['limit', tx('Key spending limit (USD)', 'Key 消费上限（USD）')], ['limit_remaining', tx('Key remaining limit (USD)', 'Key 剩余限额（USD）')], ['usage', tx('Key usage (USD)', 'Key 已用额度（USD）')]] as const) {
      const value = data.data?.[key]
      fields.push({ label, value: typeof value === 'number' && Number.isFinite(value) ? String(value) : tx('Not reported / no key limit', '未报告 / 未设置 Key 限额') })
    }
    note = tx('Limits belong to this app key, not the account balance. Any account, model or BYOK limits still apply.', '这是本应用 Key 的限额，不是账号余额，仍需遵守账号、模型及 BYOK 限制。')
  } else if (service === 'deepseek') {
    for (const b of Array.isArray(data.balance_infos) ? data.balance_infos.slice(0, 5) : []) {
      if (typeof b.currency === 'string' && /^[A-Z]{3}$/.test(b.currency) && typeof b.total_balance === 'string' && /^\d+(\.\d+)?$/.test(b.total_balance)) fields.push({ label: `${tx('Available balance', '可用余额')} (${b.currency})`, value: b.total_balance })
    }
    note = tx('Provider-reported balance; local estimated charges are not deducted from this snapshot.', '供应商报告的余额，此快照未扣减本地估算费用。')
  } else {
    if (data.base_resp?.status_code !== undefined && data.base_resp.status_code !== 0) throw new Error(`MiniMax usage lookup failed (${Number(data.base_resp.status_code) || 'provider error'})`)
    // The public page documents the endpoint, not field units. Preserve numeric field names
    // rather than interpreting undocumented countdowns as tokens or reset guarantees.
    const visit = (obj: unknown, prefix: string, depth: number) => {
      if (!obj || typeof obj !== 'object' || depth > 4 || fields.length >= 40) return
      for (const [key, value] of Object.entries(obj)) {
        if (!/^[\w]{1,64}$/.test(key) || /secret|auth|cookie|key|(?:^|_)id$/i.test(key)) continue
        const label = prefix ? `${prefix}.${key}` : key
        if (typeof value === 'number' && Number.isFinite(value)) fields.push({ label, value: String(value) })
        else if (key !== 'base_resp') visit(value, label, depth + 1)
        if (fields.length >= 40) break
      }
    }
    visit(data, '', 0)
    note = tx('Original numeric fields from MiniMax. Units and windows follow the provider; undocumented fields are not interpreted as remaining tokens or reset times.', 'MiniMax 返回的原始数值字段，单位和窗口以供应商为准；不将未说明字段推断为剩余 Token 或重置时间。')
  }
  if (!fields.length) throw new Error(tx('No recognized usage fields were returned. Check the provider console.', '未返回可识别的用量字段，请检查供应商控制台。'))
  return { checkedAt: Date.now(), sourceUrl: url, fields, note }
}
