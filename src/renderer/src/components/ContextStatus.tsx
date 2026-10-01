import { tx } from '../../../shared/i18n.ts'
import { fundingLabel, usageUrl, usageApi } from '../../../shared/provider-access.ts'
import { matchesConnection } from '../../../shared/connection-status.ts'
import { useState } from 'react'
import { toast } from 'sonner'
import type { ProviderUsageSnapshot } from '../../../shared/types.ts'
import { useStore, useTicker } from '../lib/store.tsx'
import { api } from '../lib/api.ts'
import { fmtDateTime, fmtTokens } from '../lib/format.ts'
import { Button } from './ui.tsx'

export function ContextStatus() {
  const { activeProvider: provider, logs } = useStore()
  const [lookup, setLookup] = useState<{ connection: string; data: ProviderUsageSnapshot }>()
  const [busy, setBusy] = useState(false)
  useTicker()
  if (!provider) return null
  const connection = `${provider.id}:${provider.connectionFingerprint ?? ''}`
  const snapshot = lookup?.connection === connection ? lookup.data : undefined
  const last = logs.find((l) => matchesConnection(l, provider) && l.targetModel === provider.model && !l.notSent)
  const reported = last && (last.usageReported === true || (last.usageReported !== false && last.inputTokens > 0))
  const used = last ? reported ? last.inputTokens + (last.contextWindowKind === 'input' ? 0 : last.outputTokens) : last.estimatedInputTokens : undefined
  const window = last?.contextWindow
  const percent = used !== undefined && window ? Math.round(used / window * 100) : undefined
  const url = usageUrl(provider)
  return <div className="space-y-2 border-t border-border px-5 py-3 text-[12px] text-muted">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>{fundingLabel(provider)} · {tx('Latest model request context', '模型最近请求的上下文')}: {used === undefined ? tx('Unknown', '未知') : `${fmtTokens(used)} · ${reported ? tx('Provider reported', '供应商报告') : tx('Text estimate', '文本估算')}`}{window ? ` / ${fmtTokens(window)} (${percent ?? '—'}%)` : ` · ${tx('Window unknown', '窗口未知')}`}</span>
      <div className="flex gap-2">
        {usageApi(provider) ? <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); try { setLookup({ connection, data: await api.providerUsage(provider.id) }) } catch (e) { toast.error((e as Error).message) } finally { setBusy(false) } }}>{tx('Check provider usage', '查询供应商用量')}</Button> : null}
        {url ? <Button size="sm" variant="ghost" onClick={() => void api.openExternal(url)}>{tx('Manage usage', '管理用量')}</Button> : null}
      </div>
    </div>
    {last ? <p>{fmtDateTime(last.ts)} · {last.targetModel}{!reported ? ` · ${tx('A rough text estimate; images, audio and reasoning state may be excluded.', '粗略文本估算，可能未计入图像、音频和推理状态。')}` : ''}</p> : null}
    {!last ? <p>{tx('Waiting for a request from the current connection and default model. Earlier records remain in Usage & diagnostics.', '等待当前连接与默认模型的新请求；历史记录仍保留在用量与诊断中。')}</p> : null}
    {last?.contextWindowSource ? <p>{tx('Window source', '窗口来源')}: {{ official: tx('Official reference', '官方资料'), api: tx('Provider API', '供应商接口'), user: tx('User supplied', '手动填写') }[last.contextWindowSource]}{last.contextWindowCheckedAt ? ` · ${fmtDateTime(last.contextWindowCheckedAt)}` : ''}</p> : null}
    {percent !== undefined && percent >= 80 ? <p className="text-warning">{tx('Context is approaching the recorded limit. Compact or start a new conversation in Accio before continuing.', '上下文接近记录的上限，建议继续前先在 Accio 整理或新建会话。')}</p> : null}
    <p>{provider.fundingSource === 'subscription' ? tx('Remaining allowance is unknown here. Provider usage, app limits and extra charges follow the provider’s console.', '此处未知剩余额度；套餐、应用限额和额外扣费以供应商控制台为准。') : tx('This is one model request, not the total length of every conversation. Accio controls its own compression.', '这是一次模型请求的状态，不代表全部会话的长度；压缩由 Accio 控制。')}</p>
    {snapshot ? <details className="rounded-lg border border-border p-3" open>
      <summary className="cursor-pointer font-medium">{tx('Provider usage snapshot', '供应商用量快照')} · {fmtDateTime(snapshot.checkedAt)}</summary>
      <dl className="mt-2 space-y-1">{snapshot.fields.map((f) => <div key={f.label} className="flex flex-wrap justify-between gap-3"><dt className="break-all">{f.label}</dt><dd className="tabular">{f.value}</dd></div>)}</dl>
      <p className="mt-2">{snapshot.note}</p><p className="mt-1 break-all text-[11px] text-subtle">{tx('Source', '来源')}: {snapshot.sourceUrl}</p>
    </details> : null}
  </div>
}
