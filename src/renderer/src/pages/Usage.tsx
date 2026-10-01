import { getLanguage, tr, tx } from '../../../shared/i18n.ts'
import { requestDiagnosis } from '../../../shared/diagnostics.ts'
import { fundingLabel, usageUrl } from '../../../shared/provider-access.ts'
import { ContextStatus } from '../components/ContextStatus.tsx'
import { Activity, Copy, MoreHorizontal, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { RequestCapture, RequestLog, UsageStats } from '../../../shared/types.ts'
import { OFFICIAL_PROVIDER_ID } from '../../../shared/types.ts'
import { PageHeader, useSwitchProvider } from '../App.tsx'
import { ShareList, StackedBars } from '../components/charts.tsx'
import { Badge, Button, Card, CardHeader, Confirm, EmptyState, Input, Menu, MenuContent, MenuItem, MenuTrigger, SelectBox, Sheet, Skeleton, TabsBar } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { cn, fmtCost, fmtDateTime, fmtMs, fmtNumber, fmtTime, fmtTokens } from '../lib/format.ts'

function fmtWhen(ts: number): string {
  const today = new Date().setHours(0, 0, 0, 0)
  if (ts >= today) return fmtTime(ts)
  const d = new Date(ts)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${fmtTime(ts).slice(0, 5)}`
}
import { useStore } from '../lib/store.tsx'
import { StatusIcon } from './Home.tsx'

type Range = '7' | '14' | '30'

function KpiCell({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-5 py-4">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 font-display text-[22px] font-semibold tracking-tight tabular">{value}</div>
      {sub ? <div className="mt-0.5 text-[11.5px] leading-relaxed break-words text-subtle">{sub}</div> : null}
    </div>
  )
}

function Detail({ log, onClose }: { log: RequestLog | null; onClose: () => void }) {
  const { modelName, go, state } = useStore()
  const switchTo = useSwitchProvider()
  const [capture, setCapture] = useState<RequestCapture | undefined>()
  useEffect(() => {
    let current = true
    setCapture(undefined)
    if (log) void api.logCapture(log.id).then((value) => { if (current) setCapture(value) }).catch(() => {})
    return () => { current = false }
  }, [log])
  if (!log) return null
  const diagnosis = requestDiagnosis(log)
  const loggedProvider = state?.providers.find((p) => p.id === log.providerId)
  const manageUrl = loggedProvider ? usageUrl(loggedProvider) : undefined
  const rows: [string, React.ReactNode][] = [
    [tr("时间"), fmtDateTime(log.ts)],
    [tr("模式"), log.mode === 'byok' ? `BYOK · ${log.providerName}` : tr("Accio 官方")],
    [tr("Accio 模型"), log.accioModel ? `${modelName(log.accioModel)}${modelName(log.accioModel) !== log.accioModel ? ` · ${log.accioModel}` : ''}` : '—'],
    [tr("实际模型"), <span className="font-mono">{log.targetModel || '—'}</span>],
    [tr("状态"), log.notSent ? tr("本地拦截 · 本次未发送") : log.status === 'ok' ? tr("成功") : log.status === 'aborted' ? tr("已取消") : tr("失败{0}", log.httpStatus ? ` (${log.httpStatus})` : '')],
    [tr("首字延迟"), fmtMs(log.ttftMs)],
    [tr("总耗时"), fmtMs(log.durationMs)],
    [tr("输入 Token"), log.usageReported === false ? tr("未报告") : fmtNumber(log.inputTokens)],
    [tr("缓存读取 Token"), log.cacheReadReported || log.cachedTokens > 0 ? fmtNumber(log.cachedTokens) : tr("未报告")],
    [tr("缓存写入 Token"), log.cacheWriteReported || log.cacheWriteTokens !== undefined ? fmtNumber(log.cacheWriteTokens ?? 0) : tr("未报告")],
    [tr("未缓存输入 Token"), log.cacheReadReported && log.cacheWriteReported ? fmtNumber(Math.max(0, log.inputTokens - log.cachedTokens - (log.cacheWriteTokens ?? 0))) : tr("缓存字段不完整，无法准确拆分")],
    [tr("输出 Token"), log.usageReported === false ? tr("未报告") : `${fmtNumber(log.outputTokens)}${log.reasoningTokens ? tr("（思考 {0}）", fmtNumber(log.reasoningTokens)) : ''}`],
    [tr("工具调用"), String(log.toolCalls)],
    [tr("结束原因"), log.finishReason ?? '—'],
    [tx('Billing source', '计费来源'), log.mode === 'official' ? tr('Accio 官方') : fundingLabel({ fundingSource: log.fundingSource })],
    [tx('Error code', '错误代码'), log.errorCode || '—'],
    [tx('Provider request ID', '供应商请求 ID'), log.requestId || '—'],
    [tx('Recorded context window', '记录的上下文窗口'), log.contextWindow ? fmtTokens(log.contextWindow) : tx('Unknown', '未知')],
    [log.costComplete === false && log.costUsd !== undefined ? tr("已估算部分") : tr("预估花费"), log.fundingSource === 'subscription' ? tx('Plan / extra usage · see provider billing', '套餐 / 额外用量 · 以供应商账单为准') : log.fundingSource === 'local' ? tx('Local model', '本地模型') : log.costUsd === undefined ? tr("未知（未设置完整单价或缺少用量）") : fmtCost(log.costUsd)],
    [tr("单价来源"), log.pricing ? tr("本次请求时保存的配置{0}", log.pricingUpdatedAt ? ` · ${fmtDateTime(log.pricingUpdatedAt)}` : tr(" · 更新时间未记录")) : tr("未记录")],
    [tr("会话"), <span className="font-mono text-[11.5px]">{log.conversationId ?? '—'}</span>],
  ]
  const copy = async (v: unknown) => {
    try { await navigator.clipboard.writeText(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); toast.success(tr("已复制")) }
    catch (e) { toast.error(tr("复制失败"), { description: (e as Error).message }) }
  }
  return (
    <Sheet open={!!log} onOpenChange={(v) => !v && onClose()} title={log.targetModel || log.accioModel || tr("请求详情")}>
      {log.error ? (
        <div className="mb-4 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3">
          <p className="mb-1 font-medium text-danger">{diagnosis.label}</p>
          <p className="mb-2 text-[12px] text-muted">{diagnosis.action}</p>
          <p className="text-[13px] leading-relaxed text-danger" data-selectable>
            {log.error.replace(/^\[Accio (?:Switch|BYOK)\]\s*/, '')}
          </p>
          {log.mode === 'byok' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {manageUrl ? <Button size="sm" onClick={() => void api.openExternal(manageUrl)}>{tx('Manage usage', '管理用量')}</Button> : null}
              {state?.providers.filter((p) => p.fallbackEligible && p.id !== state.activeProviderId).map((p) => <Button size="sm" key={p.id} onClick={() => void switchTo(p.id, p.name)}>{tx('Next request', '下次请求')} → {p.name}</Button>)}
              {state?.providers.some((p) => p.id === log.providerId) ? (
                <Button
                  size="sm"
                  onClick={() => {
                    onClose()
                    go('providers', `edit:${log.providerId}`)
                  }}
                >
                  {tr("编辑 ")}{log.providerName}
                </Button>
              ) : null}
              {state?.activeProviderId === log.providerId ? (
                <Button size="sm" onClick={() => void switchTo(OFFICIAL_PROVIDER_ID, tr("Accio 官方"))}>
                  {tr("切回 Accio 官方")}</Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <dl className="divide-y divide-border rounded-xl border border-border">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-4 px-4 py-2.5 text-[13px]">
            <dt className="shrink-0 text-muted">{k}</dt>
            <dd className="min-w-0 truncate text-right" data-selectable>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 space-y-2"><Button size="sm" onClick={() => void copy({ app: 'Accio BYOK', version: state?.version, time: new Date(log.ts).toISOString(), mode: log.mode, status: log.status, httpStatus: log.httpStatus, durationMs: log.durationMs, ttftMs: log.ttftMs, inputTokens: log.inputTokens, outputTokens: log.outputTokens, cachedTokens: log.cachedTokens, cacheWriteTokens: log.cacheWriteTokens, usageReported: log.usageReported, toolCalls: log.toolCalls, costComplete: log.costComplete, proxyRunning: state?.proxy.running, accioRunning: state?.accio.running })}><Copy />{tr("复制脱敏诊断")}</Button><p className="text-[12px] text-subtle">{tr("仅复制版本、请求状态、耗时与用量；不包含 Key、地址、名称、错误原文和会话正文。")}</p></div>
      {capture ? (
        <div className="mt-5 space-y-4">
          {(
            [
              [tr("Accio 原始请求"), capture.request],
              [tr("发给供应商的请求"), capture.upstreamRequest],
              [tr("返回给 Accio 的帧"), capture.events.join('')],
            ] as [string, unknown][]
          )
            .filter(([, v]) => v)
            .map(([title, v]) => (
              <div key={title}>
                <div className="mb-1.5 flex items-center justify-between">
                  <h4 className="text-[12.5px] font-medium">{title}</h4>
                  <Button variant="ghost" size="sm" onClick={() => copy(v)}>
                    <Copy />
                    {tr("复制")}</Button>
                </div>
                <pre className="max-h-72 overflow-auto rounded-xl border border-border bg-fg/[0.03] p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all" data-selectable>
                  {(typeof v === 'string' ? v : JSON.stringify(v, null, 2)).slice(0, 60_000)}
                </pre>
              </div>
            ))}
        </div>
      ) : (
        <p className="mt-4 text-[12px] text-subtle">{tr("在「设置 → 调试」中开启请求捕获后，可在这里查看最近 30 次请求的完整内容。")}</p>
      )}
    </Sheet>
  )
}

export function UsagePage() {
  const language = getLanguage()
  const { logs, modelName, intent, clearIntent } = useStore()
  const [range, setRange] = useState<Range>('7')
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [statsError, setStatsError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [q, setQ] = useState('')
  const [provider, setProvider] = useState('all')
  const [status, setStatus] = useState('all')
  const [selected, setSelected] = useState<RequestLog | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const latest = logs[0]?.id

  useEffect(() => {
    let current = true
    setStats(null)
    setStatsError(undefined)
    const t = setTimeout(() => void api.usageStats(Number(range)).then((v) => { if (current) setStats(v) }).catch((e) => { if (current) setStatsError(e.message) }), 200)
    return () => { current = false; clearTimeout(t) }
  }, [range, latest, reload])

  useEffect(() => {
    if (!intent?.startsWith('log:')) return
    const target = logs.find((l) => l.id === intent.slice(4))
    if (target) setSelected(target)
    clearIntent()
  }, [intent, clearIntent, logs])

  const providerOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of logs) m.set(l.providerId, l.mode === 'official' ? tr('Accio 官方') : l.providerName)
    return [{ value: 'all', label: tr("全部来源") }, ...[...m].map(([value, label]) => ({ value, label }))]
  }, [logs, language])

  const filtered = logs.filter(
    (l) =>
      (provider === 'all' || l.providerId === provider) &&
      (status === 'all' || l.status === status) &&
      (!q || `${l.accioModel} ${l.targetModel} ${l.providerName} ${l.error ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  )

  const t = stats?.totals
  const successRate = t && t.requests ? ((t.requests - t.errors - (t.aborted ?? 0)) / t.requests) * 100 : undefined
  const chartData = (stats?.byDay ?? []).map((d) => ({ key: d.key, input: d.inputTokens, output: d.outputTokens, requests: d.requests }))

  return (
    <>
      <PageHeader
        title={tr("用量与诊断")}
        description={tr("每一次模型调用的耗时、Token 和状态都在这里，官方模式也会统计。")}
        actions={
          <>
            <TabsBar
              value={range}
              onChange={setRange}
              tabs={[
                { value: '7', label: tr("7 天") },
                { value: '14', label: tr("14 天") },
                { value: '30', label: tr("30 天") },
              ]}
            />
            <Menu>
              <MenuTrigger asChild>
                <Button size="icon" aria-label={tr("更多")}>
                  <MoreHorizontal />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem danger onSelect={() => setConfirmClear(true)}>
                  <Trash2 />
                  {tr("清空全部日志")}</MenuItem>
              </MenuContent>
            </Menu>
          </>
        }
      />
      <div className="space-y-6">
        {statsError ? <div role="alert" className="rounded-xl bg-danger-soft p-4 text-[13px] text-danger"><p>{tr("读取用量失败：")}{statsError}</p><Button className="mt-2" size="sm" onClick={() => setReload((n) => n + 1)}>{tr("重试")}</Button></div> : null}
        <Card>
          <div className="grid grid-cols-2 divide-x divide-border lg:grid-cols-5">
            <KpiCell label={tr("请求")} value={t ? fmtNumber(t.requests) : '—'} sub={t ? tr("平均 {0}", fmtMs(t.requests ? t.durationMs / t.requests : undefined)) : undefined} />
            <KpiCell label={tr("成功率")} value={successRate !== undefined ? `${successRate.toFixed(successRate === 100 ? 0 : 1)}%` : '—'} sub={t ? tr("{0} 次失败 · {1} 次取消", t.errors, t.aborted ?? 0) : undefined} />
            <KpiCell label={tr("已报告输入")} value={t ? fmtTokens(t.inputTokens) : '—'} sub={t?.cacheReportedInputTokens ? tr("有报告的请求命中 {0}%", Math.round(((t.cacheReportedTokens ?? 0) / t.cacheReportedInputTokens) * 100)) : tr("缓存命中未报告")} />
            <KpiCell label={tr("输出 Token")} value={t ? fmtTokens(t.outputTokens) : '—'} sub={t && t.reasoningTokens ? tr("思考 {0}", fmtTokens(t.reasoningTokens)) : undefined} />
            <KpiCell label={tr("已估算花费")} value={t?.estimatedRequests ? fmtCost(t.costUsd) : '—'} sub={t ? `${t.fullyEstimatedRequests ?? 0} / ${t.apiRequests ?? 0} ${tx('API requests priced', '次 API 完整计价')}` : undefined} />
          </div>
        </Card>
        {t ? <p className="text-[12px] text-muted">API {t.apiRequests ?? 0} · {tx('Subscription', '订阅')} {t.subscriptionRequests ?? 0} · {tx('Local', '本地')} {t.localRequests ?? 0}</p> : null}
        <p className="text-[12px] leading-relaxed text-subtle">{tr("费用仅合计已有单价和用量的部分；缺少数据不代表免费，实际账单以供应商为准。缓存读取与写入分别计费；允许缓存不等于每次命中，压缩或更换前缀后可能重新写入。")}</p>
        <Card><ContextStatus /></Card>

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_320px]">
          <Card>
            <CardHeader title={tr("每日 Token")} description={tr("{0} 天", Number(range))} />
            <div className="px-5 pt-4 pb-5">
              {stats ? (
                <StackedBars
                  data={chartData}
                  series={[
                    { key: 'input', label: tr("输入"), color: 'var(--series-1)' },
                    { key: 'output', label: tr("输出"), color: 'var(--series-2)' },
                  ]}
                  format={fmtTokens}
                  xLabel={(d) => String(d.key).slice(5).replace('-', '/')}
                  tooltipTitle={(d) => tr("{0} · {1} 次请求", String(d.key).slice(5).replace('-', '/'), d.requests)}
                />
              ) : (
                <Skeleton className="h-[250px] w-full" />
              )}
            </div>
          </Card>
          <Card>
            <CardHeader title={tr("按来源")} description={tr("请求次数")} />
            <div className="px-5 pt-4 pb-5">
              {stats ? (
                <ShareList
                  items={stats.byProvider.map((p) => ({ key: p.key, label: p.key === OFFICIAL_PROVIDER_ID ? tr('Accio 官方') : p.name, value: p.requests, sub: `${fmtTokens(p.inputTokens + p.outputTokens)} Token${p.costUsd ? ` · ${fmtCost(p.costUsd)}` : ''}` }))}
                  format={(n) => fmtNumber(n)}
                />
              ) : (
                <Skeleton className="h-40 w-full" />
              )}
              {stats && stats.byModel.length ? (
                <>
                  <h4 className="mt-6 mb-3 text-[13px] font-semibold">{tr("按模型")}</h4>
                  <ShareList items={stats.byModel.slice(0, 6).map((m) => ({ key: m.key, label: modelName(m.key) === m.key ? <span className="font-mono text-[12.5px]">{m.key}</span> : modelName(m.key), value: m.requests }))} format={(n) => fmtNumber(n)} />
                </>
              ) : null}
            </div>
          </Card>
        </div>

        <Card>
          <CardHeader
            title={tr("请求日志")}
            description={tr("最近 {0} 条，实时更新", logs.length)}
            action={
              <>
                <div className="relative w-52">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("搜索模型或错误")} className="h-8 pl-8" aria-label={tr("搜索日志")} />
                </div>
                <div className="w-36">
                  <SelectBox label={tr("来源")} value={provider} onChange={setProvider} options={providerOptions} className="h-8" />
                </div>
                <div className="w-28">
                  <SelectBox
                    label={tr("状态")}
                    value={status}
                    onChange={setStatus}
                    className="h-8"
                    options={[
                      { value: 'all', label: tr("全部状态") },
                      { value: 'ok', label: tr("成功") },
                      { value: 'error', label: tr("失败") },
                      { value: 'aborted', label: tr("已取消") },
                    ]}
                  />
                </div>
              </>
            }
          />
          <div className="mt-3 overflow-x-auto px-2 pb-2">
            {filtered.length ? (
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="text-left text-[11.5px] text-subtle">
                    <th className="px-3 py-2 font-medium">{tr("时间")}</th>
                    <th className="px-3 py-2 font-medium">{tr("来源")}</th>
                    <th className="px-3 py-2 font-medium">{tr("模型")}</th>
                    <th className="px-3 py-2 text-right font-medium">{tr("输入")}</th>
                    <th className="px-3 py-2 text-right font-medium">{tr("输出")}</th>
                    <th className="px-3 py-2 text-right font-medium">{tr("首字")}</th>
                    <th className="px-3 py-2 text-right font-medium">{tr("耗时")}</th>
                    <th className="px-3 py-2 text-center font-medium">{tr("状态")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 200).map((l) => (
                    <tr
                      key={l.id}
                      tabIndex={0}
                      aria-label={tr("{0} {1} 请求详情", fmtDateTime(l.ts), l.mode === 'official' ? tr('Accio 官方') : l.providerName)}
                      onClick={() => setSelected(l)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setSelected(l)
                        }
                      }}
                      className="cursor-default border-t border-border transition outline-none hover:bg-surface-hover focus-visible:bg-accent-soft"
                    >
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted tabular">{fmtWhen(l.ts)}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={l.mode === 'byok' ? 'accent' : 'neutral'}>{l.mode === 'byok' ? l.providerName : tr("官方")}</Badge>
                      </td>
                      <td className="max-w-[280px] px-3 py-2.5">
                        <div className={cn('truncate', l.mode === 'byok' && 'font-mono')}>{l.mode === 'byok' ? l.targetModel : modelName(l.accioModel)}</div>
                        {l.error ? <div className="truncate text-[11.5px] text-danger">{l.error}</div> : l.mode === 'byok' && l.accioModel !== l.targetModel ? <div className="truncate text-[11px] text-subtle">{tr("Accio 选择：")}{modelName(l.accioModel)}</div> : null}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular">{fmtTokens(l.inputTokens)}</td>
                      <td className="px-3 py-2.5 text-right tabular">{fmtTokens(l.outputTokens)}</td>
                      <td className="px-3 py-2.5 text-right text-muted tabular">{fmtMs(l.ttftMs)}</td>
                      <td className={cn('px-3 py-2.5 text-right tabular', l.durationMs > 60_000 && 'text-warning')}>{fmtMs(l.durationMs)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-center">
                          <StatusIcon log={l} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState icon={<Activity />} title={logs.length ? tr("没有符合条件的请求") : tr("还没有请求")} description={logs.length ? tr("换个筛选条件试试。") : tr("通过 Accio BYOK 启动 Accio 并发一条消息后，这里会实时出现记录。")} />
            )}
          </div>
        </Card>
      </div>
      <Detail log={selected} onClose={() => setSelected(null)} />
      <Confirm
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={tr("清空全部日志？")}
        description={tr("所有请求记录和用量统计都会被删除，不影响供应商配置。")}
        confirmText={tr("清空")}
        danger
        onConfirm={async () => {
          await api.clearLogs()
          setStats(await api.usageStats(Number(range)))
          toast(tr("日志已清空"))
        }}
      />
    </>
  )
}
