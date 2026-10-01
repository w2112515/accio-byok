import { tr } from '../../../shared/i18n.ts'
import { AlertTriangle, ArrowRight, Check, CheckCircle2, CircleDashed, Cpu, MoreHorizontal, Plus, Power, RotateCw, Sparkles, X, XCircle, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { OFFICIAL_PROVIDER_ID, type RequestLog, type UsageStats } from '../../../shared/types.ts'
import { findPreset } from '../../../shared/presets.ts'
import { PageHeader, StartAccioButton, useSwitchProvider } from '../App.tsx'
import { AppLogo, OfficialAvatar, ProviderAvatar } from '../components/brand.tsx'
import { ConnectionStatus } from '../components/ConnectionStatus.tsx'
import { MiniBars } from '../components/charts.tsx'
import { Badge, Button, Card, CardHeader, Confirm, EmptyState, Menu, MenuContent, MenuItem, MenuTrigger, Skeleton, Tip } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { cn, fmtCost, fmtMs, fmtNumber, fmtTokens, timeAgo } from '../lib/format.ts'
import { useStore, useTicker } from '../lib/store.tsx'

function useStats(days: number): UsageStats | null {
  const { logs } = useStore()
  const [stats, setStats] = useState<UsageStats | null>(null)
  const latest = logs[0]?.id
  useEffect(() => {
    let current = true
    const t = setTimeout(() => void api.usageStats(days).then((v) => { if (current) setStats(v) }).catch((e) => { if (current) { setStats(null); toast.error(tr("读取用量失败，请到用量页重试"), { id: 'usage-read-error', description: e.message }) } }), 250)
    return () => { current = false; clearTimeout(t) }
  }, [days, latest])
  return stats
}

function FlowNode({ icon, title, subtitle, tone = 'neutral' }: { icon: React.ReactNode; title: string; subtitle: React.ReactNode; tone?: 'neutral' | 'accent' | 'muted' }) {
  return (
    <div className={cn('flex min-w-0 flex-1 items-center gap-3 rounded-xl border px-3.5 py-3', tone === 'accent' ? 'border-accent/30 bg-accent-soft' : 'border-border bg-surface-2', tone === 'muted' && 'opacity-60')}>
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold">{title}</div>
        <div className="truncate text-[11.5px] text-muted">{subtitle}</div>
      </div>
    </div>
  )
}

function FlowLink({ active, broken }: { active: boolean; broken?: boolean }) {
  return (
    <svg width="44" height="12" viewBox="0 0 44 12" className="shrink-0" aria-hidden>
      <line x1="2" y1="6" x2="42" y2="6" stroke={broken ? 'var(--danger)' : active ? 'var(--accent)' : 'var(--border-strong)'} strokeWidth="2" strokeLinecap="round" strokeDasharray={active ? '5 7' : broken ? '2 5' : '0'} className={active ? 'animate-flow' : ''} />
    </svg>
  )
}

function HeroCard() {
  const { state, activeProvider, go } = useStore()
  const [busy, setBusy] = useState<'takeover' | 'direct' | 'stop' | null>(null)
  const [confirm, setConfirm] = useState(false)
  if (!state) return <Skeleton className="h-52 w-full rounded-2xl" />
  const { accio, proxy } = state
  const byok = state.activeProviderId !== OFFICIAL_PROVIDER_ID && activeProvider
  // Before any provider exists the next step is adding one; don't compete with it.
  const guideFirst = state.providers.length === 0

  const run = async (kind: 'takeover' | 'direct' | 'stop') => {
    setBusy(kind)
    try {
      if (kind === 'takeover') {
        await api.accioTakeover()
        toast.success(tr("Accio 已启动"), { description: tr("请发送一条消息，在这里核对实际模型和结果") })
      } else if (kind === 'direct') {
        await api.accioLaunchDirect()
        toast(tr("Accio 已恢复官方直连"))
      } else {
        await api.accioStop()
        toast(tr("Accio 已关闭"))
      }
    } catch (e) {
      toast.error(tr("操作失败"), { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  let headline: React.ReactNode
  let detail: React.ReactNode
  let tone: 'success' | 'warning' | 'danger' | 'neutral'
  if (state.configError) {
    tone = 'danger'
    headline = tr("请先恢复配置")
    detail = tr("原文件已保留，请使用上方恢复入口。")
  } else if (!accio.installed) {
    tone = 'danger'
    headline = tr("没有找到 Accio")
    detail = tr("请在设置中指定 Accio.exe 的位置。")
  } else if (!proxy.running) {
    tone = 'danger'
    headline = tr("本地代理没有运行")
    detail = proxy.error ?? tr("端口可能被占用，请在设置中更换端口。")
  } else if (accio.takenOver) {
    tone = 'success'
    headline = byok ? tr("已选择 {0}", activeProvider.name) : tr("已选择 Accio 官方模型")
    detail = byok
      ? tr("模型请求由你的 Key 处理（{0}），登录、插件、同步等其余功能照常走官方。", activeProvider.model || tr("未设置模型"))
      : tr("请求原样转发到 Accio 官方网关，使用 Accio 自带额度。随时可以切到自己的模型。")
  } else if (accio.launchedByUs) {
    tone = 'neutral'
    headline = tr("Accio 已启动，等待请求")
    detail = tr("在 Accio 中发送一条消息，下面会显示实际模型、时间和调用结果。")
  } else if (accio.running) {
    tone = 'warning'
    headline = tr("Accio 的接入尚未确认")
    detail = tr("还没有观察到本次运行的代理请求。接管会重启 Accio，进行中的任务会被中断。")
  } else {
    tone = 'neutral'
    headline = tr("Accio 未运行")
    detail = tr("通过 Accio BYOK 启动 Accio 后，就可以随时热切换模型来源。")
  }

  const primary = state.configError ? null : !accio.installed || !proxy.running ? (
    <Button variant="primary" size="lg" onClick={() => go('settings')}>
      {tr("去设置")}</Button>
  ) : accio.takenOver || accio.launchedByUs ? (
    <Button size="lg" onClick={() => go('usage')}>
      <ArrowRight />
      {tr("查看请求")}</Button>
  ) : accio.running ? (
    <Button variant={guideFirst ? 'secondary' : 'primary'} size="lg" loading={busy === 'takeover'} onClick={() => setConfirm(true)}>
      <Zap />
      {tr("接管 Accio")}</Button>
  ) : (
    <Button variant={guideFirst ? 'secondary' : 'primary'} size="lg" loading={busy === 'takeover'} onClick={() => run('takeover')}>
      <Power />
      {tr("启动 Accio")}</Button>
  )

  const StatusIcon = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, neutral: CircleDashed }[tone]
  return (
    <Card className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full opacity-60 blur-3xl"
        style={{ background: tone === 'success' ? 'radial-gradient(closest-side, color-mix(in oklch, var(--accent) 35%, transparent), transparent)' : 'radial-gradient(closest-side, color-mix(in oklch, var(--warning) 25%, transparent), transparent)' }}
      />
      <div className="relative p-6">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div
              className={cn(
                'mb-2 inline-flex items-center gap-1.5 text-[12.5px] font-medium',
                { success: 'text-success', warning: 'text-warning', danger: 'text-danger', neutral: 'text-muted' }[tone],
              )}
            >
              <StatusIcon className="size-4" />
              {state.busyOperation ? tr("正在{0}", state.busyOperation) : accio.launchedByUs && !accio.takenOver ? tr("等待验证") : { success: tr("代理已收到请求"), warning: tr("接入未确认"), danger: tr("需要处理"), neutral: tr("待启动") }[tone]}
            </div>
            <h2 className="font-display text-[22px] font-semibold tracking-tight">{headline}</h2>
            <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-muted">{detail}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {primary}
            {accio.installed ? (
              <Menu>
                <MenuTrigger asChild>
                  <Button size="icon" className="size-11 rounded-xl" aria-label={tr("更多操作")}>
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onSelect={() => setConfirm(true)} disabled={!!busy || !!state.busyOperation}>
                    <RotateCw />{tr("重启并接入 Accio")}</MenuItem>
                  <MenuItem onSelect={() => run('direct')} disabled={!!busy}>
                    <Power />
                    {tr("以官方直连方式启动 Accio")}</MenuItem>
                  <MenuItem onSelect={() => run('stop')} disabled={!accio.running || !!busy}>
                    <XCircle />
                    {tr("关闭 Accio")}</MenuItem>
                </MenuContent>
              </Menu>
            ) : null}
          </div>
        </div>

        <div className="mt-6 flex items-center">
          <FlowNode icon={<OfficialAvatar size={34} />} title="Accio" subtitle={accio.running ? tr("运行中 · {0} 个进程", accio.pids.length) : tr("未运行")} tone={accio.running ? 'neutral' : 'muted'} />
          <FlowLink active={accio.takenOver} broken={accio.running && !accio.takenOver && !accio.launchedByUs} />
          <FlowNode icon={<AppLogo className="size-[34px]" />} title="Accio BYOK" subtitle={proxy.running ? `127.0.0.1:${proxy.port}` : tr("代理已停止")} tone="accent" />
          <FlowLink active={accio.takenOver} />
          {byok ? (
            <FlowNode icon={<ProviderAvatar presetId={activeProvider.presetId} name={activeProvider.name} size={34} />} title={activeProvider.name} subtitle={<span className="font-mono">{activeProvider.model || tr("未设置模型")}</span>} />
          ) : (
            <FlowNode icon={<div className="flex size-[34px] items-center justify-center rounded-xl bg-fg/[0.06] text-muted"><Cpu className="size-4" /></div>} title={tr("Accio 官方网关")} subtitle={tr("使用 Accio 自带额度")} />
          )}
        </div>
      </div>
      <EvidenceStrip />
      {byok ? <div className="px-6 pb-4"><ConnectionStatus value={activeProvider.protection} /></div> : null}
      <Confirm
        open={confirm}
        onOpenChange={setConfirm}
        title={tr("接管 Accio？")}
        description={tr("Accio 会被关闭并通过 Accio BYOK 重新启动。正在生成的回复和运行中的任务会被中断，会话记录不受影响。")}
        confirmText={tr("接管并重启")}
        onConfirm={() => run('takeover')}
      />
    </Card>
  )
}

/**
 * The most convincing answer to "is it working?" is the last real request that went to the
 * selected source; show it, and when it failed, the ways out.
 */
function EvidenceStrip() {
  const { state, activeProvider, logs, go, modelName } = useStore()
  const switchTo = useSwitchProvider()
  useTicker()
  if (!state) return null
  const byok = state.activeProviderId !== OFFICIAL_PROVIDER_ID && activeProvider ? activeProvider : undefined
  const last = logs.find((l) => l.providerId === (byok ? byok.id : OFFICIAL_PROVIDER_ID))
  const edit = byok ? () => go('providers', `edit:${byok.id}`) : undefined

  let tone: 'success' | 'warning' | 'danger' | 'neutral' = 'neutral'
  let body: React.ReactNode
  let actions: React.ReactNode = null
  if (byok && !byok.model) {
    tone = 'danger'
    body = tr("{0} 还没有设置模型，Accio 的请求会失败。", byok.name)
    actions = (
      <Button size="sm" onClick={edit}>
        {tr("去设置")}</Button>
    )
  } else if (byok?.keyError) {
    tone = 'danger'
    body = byok.keyError
    actions = <Button size="sm" onClick={edit}>{tr("重新填写 Key")}</Button>
  } else if (byok && !byok.hasApiKey && findPreset(byok.presetId)?.category !== 'local') {
    tone = 'warning'
    body = tr("{0} 还没有填写 API Key。", byok.name)
    actions = (
      <Button size="sm" onClick={edit}>
        {tr("去填写")}</Button>
    )
  } else if (!last) {
    body = byok
      ? tr("还没有请求经过 {0}。{1}", byok.name, state.accio.takenOver || state.accio.launchedByUs ? tr("在 Accio 里发一条消息就能验证。") : tr("启动并接入 Accio 后发一条消息就能验证。"))
      : tr("还没有记录到请求。通过 Accio BYOK 启动 Accio 后，每次模型调用都会出现在这里。")
  } else if (last.status === 'error') {
    tone = 'danger'
    body = (
      <>
        <span className="font-medium">{tr("最近一次请求失败")}</span>
        <span className="text-muted"> · {timeAgo(last.ts)} · </span>
        {(last.error ?? tr("未知错误")).replace(/^\[Accio (?:Switch|BYOK)\]\s*/, '')}
      </>
    )
    actions = (
      <>
        <Button size="sm" variant="ghost" onClick={() => go('usage', `log:${last.id}`)}>
          {tr("详情")}</Button>
        {byok ? (
          <>
            <Button size="sm" onClick={edit}>
              {tr("编辑供应商")}</Button>
            <Button size="sm" onClick={() => void switchTo(OFFICIAL_PROVIDER_ID, tr("Accio 官方"))}>
              {tr("切回官方")}</Button>
          </>
        ) : null}
      </>
    )
  } else {
    tone = last.status === 'ok' ? 'success' : 'neutral'
    body = (
      <>
        <span className="font-medium">{last.status === 'ok' ? tr("最近一次请求成功") : tr("最近一次请求已取消")}</span>
        <span className="text-muted">
          {' '}
          · {timeAgo(last.ts)} · {byok ? last.targetModel : modelName(last.accioModel)} {tr(" · 首字 ")}{fmtMs(last.ttftMs)} · {fmtTokens(last.inputTokens)} {tr(" 入 / ")}{fmtTokens(last.outputTokens)} {tr(" 出")}</span>
      </>
    )
  }
  const Icon = { success: CheckCircle2, warning: AlertTriangle, danger: XCircle, neutral: CircleDashed }[tone]
  return (
    <div
      role="status"
      className={cn(
        'relative flex min-h-12 items-center gap-3 border-t px-6 py-2.5 text-[12.5px]',
        tone === 'danger' ? 'border-danger/25 bg-danger-soft' : tone === 'warning' ? 'border-warning/30 bg-warning-soft' : 'border-border bg-fg/[0.02]',
      )}
    >
      <Icon className={cn('size-4 shrink-0', { success: 'text-success', warning: 'text-warning', danger: 'text-danger', neutral: 'text-subtle' }[tone])} />
      <div className="min-w-0 flex-1 truncate" data-selectable>
        {body}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}

const ONBOARDING_DONE = 'asw.onboarding.done'
const ONBOARDING_HIDDEN = 'asw.onboarding.hidden'

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1')
  } catch {
    /* storage unavailable: the checklist simply shows again */
  }
}

/** First-run path; each step ticks itself off from real state, not from clicks. */
function Onboarding() {
  const { state, logs, go } = useStore()
  const switchTo = useSwitchProvider()
  const [hidden, setHidden] = useState(() => readFlag(ONBOARDING_HIDDEN) || readFlag(ONBOARDING_DONE))
  if (!state || hidden) return null
  const first = state.providers[0]
  const active = state.providers.find((p) => p.id === state.activeProviderId)
  const steps = [
    {
      done: state.providers.length > 0,
      title: tr("添加一个模型供应商"),
      desc: tr("填好 Key、选择模型后点「测试并启用」。"),
      action: (
        <Button size="sm" variant="primary" onClick={() => go('providers', 'add')}>
          <Plus />
          {tr("添加")}</Button>
      ),
    },
    {
      done: Boolean(active),
      title: tr("把它设为当前来源"),
      desc: tr("之后可以随时在右上角或托盘里切换。"),
      action: first ? (
        <Button size="sm" variant="primary" onClick={() => void switchTo(first.id, first.name)}>
          {tr("使用 ")}{first.name}
        </Button>
      ) : null,
    },
    {
      done: state.accio.takenOver || state.accio.launchedByUs,
      title: tr("通过 Accio BYOK 启动 Accio"),
      desc: state.accio.running ? tr("已在运行的 Accio 会重启一次，正在进行的任务会中断。") : tr("Accio BYOK 会带上本地代理地址启动它。"),
      action: <StartAccioButton />,
    },
    {
      done: logs.some((l) => l.providerId === active?.id && l.status === 'ok' && l.ts >= Math.max(state.accio.startedAt ?? 0, state.proxy.startedAt ?? 0)),
      title: tr("在 Accio 里发一条消息"),
      desc: tr("这里出现一条成功的请求，就说明一切就绪。"),
      action: null,
    },
  ]
  if (steps.every((s) => s.done)) {
    writeFlag(ONBOARDING_DONE)
    return null
  }
  const current = steps.findIndex((s) => !s.done)
  return (
    <Card>
      <CardHeader
        title={tr("开始使用")}
        description={tr("{0} / {1} 步完成", steps.filter((s) => s.done).length, steps.length)}
        action={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={tr("隐藏引导")}
            onClick={() => {
              writeFlag(ONBOARDING_HIDDEN)
              setHidden(true)
            }}
          >
            <X />
          </Button>
        }
      />
      <ol className="mt-3 space-y-1 px-3 pb-3">
        {steps.map((s, i) => (
          <li key={s.title} className={cn('flex items-center gap-3 rounded-xl px-3 py-2.5', i === current && 'bg-accent-soft')}>
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular',
                s.done ? 'bg-success text-white' : i === current ? 'bg-accent text-accent-fg' : 'bg-fg/[0.07] text-subtle',
              )}
            >
              {s.done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn('text-[13px] font-medium', s.done && 'text-muted line-through decoration-subtle/60')}>{s.title}</div>
              {i === current ? <div className="text-[12px] text-muted">{s.desc}</div> : null}
            </div>
            {i === current ? s.action : null}
          </li>
        ))}
      </ol>
    </Card>
  )
}

function QuickProviders() {
  const { state, go } = useStore()
  const switchTo = useSwitchProvider()
  if (!state) return null
  const items = [{ id: OFFICIAL_PROVIDER_ID, name: tr("Accio 官方"), model: tr("自带额度"), presetId: undefined as string | undefined }, ...state.providers]
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold tracking-tight">{tr("模型来源")}</h3>
        <Button variant="ghost" size="sm" onClick={() => go('providers')}>
          {tr("管理")}<ArrowRight />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-4">
        {items.map((p) => {
          const active = p.id === state.activeProviderId || (p.id === OFFICIAL_PROVIDER_ID && !state.providers.some((x) => x.id === state.activeProviderId))
          return (
            <button
              key={p.id}
              onClick={() => !active && switchTo(p.id, p.name)}
              className={cn(
                'group flex items-center gap-3 rounded-xl border p-3 text-left transition',
                active ? 'border-accent/50 bg-accent-soft ring-3 ring-accent-ring/40' : 'border-border bg-surface hover:-translate-y-px hover:bg-surface-hover hover:shadow-card',
              )}
            >
              {p.id === OFFICIAL_PROVIDER_ID ? <OfficialAvatar size={34} /> : <ProviderAvatar presetId={p.presetId} name={p.name} size={34} />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{p.name}</div>
                <div className="truncate font-mono text-[11.5px] text-muted">{p.model || tr("未设置模型")}</div>
              </div>
              {active ? <CheckCircle2 className="size-4 shrink-0 text-accent" /> : null}
            </button>
          )
        })}
        <button onClick={() => go('providers', 'add')} className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border-strong p-3 text-[13px] text-muted transition hover:border-accent hover:text-accent">
          <Plus className="size-4" />
          {tr("添加供应商")}</button>
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, hint }: { label: string; value: React.ReactNode; sub?: React.ReactNode; hint?: string }) {
  const body = (
    <div className="min-w-0 px-5 py-4">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="mt-1 font-display text-[24px] font-semibold tracking-tight tabular">{value}</div>
      {sub ? <div className="mt-0.5 text-[11.5px] leading-relaxed break-words text-subtle">{sub}</div> : null}
    </div>
  )
  return hint ? <Tip content={hint}>{body}</Tip> : body
}

export function StatusIcon({ log }: { log: RequestLog }) {
  if (log.status === 'ok') return <CheckCircle2 className="size-4 text-success" aria-label={tr("成功")} />
  if (log.status === 'aborted') return <CircleDashed className="size-4 text-subtle" aria-label={tr("已取消")} />
  return <XCircle className="size-4 text-danger" aria-label={tr("失败")} />
}

function RecentList() {
  const { logs, go, modelName } = useStore()
  useTicker()
  const items = logs.slice(0, 7)
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={tr("最近请求")}
        action={
          <Button variant="ghost" size="sm" onClick={() => go('usage')}>
            {tr("全部")}<ArrowRight />
          </Button>
        }
      />
      {items.length ? (
        <ul className="mt-2 divide-y divide-border px-2 pb-2">
          {items.map((l) => (
            <li key={l.id} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
              <StatusIcon log={l} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{l.mode === 'byok' ? l.targetModel : modelName(l.accioModel)}</span>
                  <Badge tone={l.mode === 'byok' ? 'accent' : 'neutral'}>{l.mode === 'byok' ? l.providerName : tr("官方")}</Badge>
                </div>
                <div className="truncate text-[11.5px] text-subtle">{l.error ? l.error : tr("{0} 入 · {1} 出{2}", fmtTokens(l.inputTokens), fmtTokens(l.outputTokens), l.toolCalls ? tr(" · {0} 次工具调用", l.toolCalls) : '')}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[12px] tabular">{fmtMs(l.durationMs)}</div>
                <div className="text-[11px] text-subtle">{timeAgo(l.ts)}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={<Sparkles />} title={tr("还没有请求")} description={tr("在 Accio 里发一条消息，这里会实时显示每次模型调用的耗时和 Token。")} />
      )}
    </Card>
  )
}

export function HomePage() {
  const { logs } = useStore()
  const today = useStats(1)
  const week = useStats(7)
  const trend = useMemo(() => (week ? week.byDay.map((d) => d.requests) : []), [week])
  const labels = useMemo(() => (week ? week.byDay.map((d) => d.key.slice(5).replace('-', '/')) : []), [week])
  const t = today?.totals
  const avgTtft = logs.filter((l) => l.ttftMs && Date.now() - l.ts < 86_400_000)
  const ttft = avgTtft.length ? avgTtft.reduce((s, l) => s + (l.ttftMs ?? 0), 0) / avgTtft.length : undefined

  return (
    <>
      <PageHeader title={tr("总览")} description={tr("用你自己的模型 Key 驱动 Accio，随时热切换。")} />
      <div className="space-y-6">
        <HeroCard />
        <Onboarding />
        <QuickProviders />
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_360px]">
          <div className="space-y-6">
            <Card>
              <div className="grid grid-cols-4 divide-x divide-border">
                <Kpi label={tr("今日请求")} value={t ? fmtNumber(t.requests) : '—'} sub={!t || !t.requests ? tr("暂无请求") : tr("{0} 失败 · {1} 取消 · 首字 {2}", t.errors, t.aborted ?? 0, fmtMs(ttft))} />
                <Kpi label={tr("输入 Token")} value={t ? fmtTokens(t.inputTokens) : '—'} sub={t && t.cachedTokens ? tr("缓存命中 {0}", fmtTokens(t.cachedTokens)) : undefined} />
                <Kpi label={tr("输出 Token")} value={t ? fmtTokens(t.outputTokens) : '—'} sub={t && t.reasoningTokens ? tr("含思考 {0}", fmtTokens(t.reasoningTokens)) : undefined} />
                <Kpi label={tr("已估算花费")} value={t?.estimatedRequests ? fmtCost(t.costUsd) : '—'} sub={t ? tr("完整计价 {0} / {1} 次", t.fullyEstimatedRequests ?? 0, t.byokRequests ?? 0) : undefined} hint={tr("只合计有单价和用量的部分，未知费用不代表免费")} />
              </div>
            </Card>
            <Card>
              <CardHeader title={tr("近 7 天")} description={week ? tr("{0} 次请求 · {1} Token", fmtNumber(week.totals.requests), fmtTokens(week.totals.inputTokens + week.totals.outputTokens)) : undefined} />
              <div className="px-5 pt-4 pb-5">{week ? <MiniBars values={trend} labels={labels} format={(n) => tr("{0} 次", n)} height={96} /> : <Skeleton className="h-24 w-full" />}</div>
            </Card>
          </div>
          <RecentList />
        </div>
      </div>
    </>
  )
}
