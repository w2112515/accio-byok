import { Activity, Boxes, Check, ChevronDown, DatabaseBackup, LayoutDashboard, Settings as SettingsIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import type { AppState } from '../../shared/api.ts'
import { OFFICIAL_PROVIDER_ID } from '../../shared/types.ts'
import { usableModelInfo } from '../../shared/model-info.ts'
import { AppLogo, OfficialAvatar, ProviderAvatar } from './components/brand.tsx'
import { Button, Confirm, PopoverBox, PopoverClose, Skeleton, StatusDot } from './components/ui.tsx'
import { api } from './lib/api.ts'
import { cn } from './lib/format.ts'
import { useStore, type Page } from './lib/store.tsx'
import { HomePage } from './pages/Home.tsx'
import { ProvidersPage } from './pages/Providers.tsx'
import { SessionsPage } from './pages/Sessions.tsx'
import { SettingsPage } from './pages/Settings.tsx'
import { UsagePage } from './pages/Usage.tsx'

const NAV: { id: Page; label: string; icon: typeof Activity }[] = [
  { id: 'home', label: '总览', icon: LayoutDashboard },
  { id: 'providers', label: '模型接入', icon: Boxes },
  { id: 'usage', label: '用量与诊断', icon: Activity },
  { id: 'sessions', label: '会话备份', icon: DatabaseBackup },
  { id: 'settings', label: '设置', icon: SettingsIcon },
]

export async function takeoverWithToast(): Promise<void> {
  const id = toast.loading('正在通过 Accio BYOK 启动 Accio…')
  try {
    await api.accioTakeover()
    toast.success('Accio 已启动', { id, description: '在 Accio 中发送消息后，可在这里核对实际模型和结果' })
  } catch (e) {
    toast.error('启动失败', { id, description: (e as Error).message })
  }
}

/** Whether the selected source actually reaches Accio right now. */
export function effectState(state: AppState): { tone: 'success' | 'warning' | 'neutral'; label: string } {
  if (state.configError || !state.proxy.running) return { tone: 'warning', label: '本地接入不可用，请查看总览中的原因' }
  if (state.busyOperation) return { tone: 'neutral', label: `正在${state.busyOperation}…` }
  if (state.accio.takenOver) return { tone: 'success', label: '代理已收到请求；最近模型结果见用量与诊断' }
  if (state.accio.launchedByUs) return { tone: 'neutral', label: 'Accio 已启动，等待首条请求' }
  return state.accio.running
    ? { tone: 'warning', label: '尚未确认接入，可重启 Accio 后验证' }
    : { tone: 'neutral', label: '已选择来源，启动 Accio 后使用' }
}

export function StartAccioButton() {
  const { state, go } = useStore()
  const [confirm, setConfirm] = useState(false)
  if (!state) return null
  if (!state.accio.installed) return <Button variant="primary" onClick={() => go('settings')}>指定 Accio 位置</Button>
  if (state.accio.takenOver || state.accio.launchedByUs) return <Button onClick={() => go('home')}>查看接入状态</Button>
  return <>
    <Button variant="primary" disabled={!!state.configError || !!state.busyOperation} onClick={() => state.accio.running ? setConfirm(true) : void takeoverWithToast()}>{state.accio.running ? '接管并重启 Accio' : '启动 Accio'}</Button>
    <Confirm open={confirm} onOpenChange={setConfirm} title="接管并重启 Accio？" description="正在生成的回复和运行中的任务会中断。请先保存工作，再通过本地代理重新启动。" confirmText="接管并重启" onConfirm={takeoverWithToast} />
  </>
}

/**
 * Switch the active source and say honestly when it takes effect: immediately only if
 * Accio is routed through the proxy; otherwise offer the action that makes it effective.
 */
export function useSwitchProvider(): (id: string, name: string) => Promise<void> {
  const { state, go } = useStore()
  return useCallback(
    async (id, name) => {
      try {
        await api.activateProvider(id)
      } catch (e) {
        toast.error('切换失败', { description: (e as Error).message })
        return
      }
      const accio = state?.accio
      const next = state?.providers.find((p) => p.id === id)
      const prev = state?.providers.find((p) => p.id === state.activeProviderId)
      const nextWindow = next && usableModelInfo(next)?.contextWindow
      const prevWindow = prev && usableModelInfo(prev)?.contextWindow
      const windowNote = next && !nextWindow ? '该模型窗口未知，长会话请核对供应商限制。' : nextWindow && prevWindow && nextWindow < prevWindow ? '目标模型窗口更小，建议先在 Accio 中整理或新建会话。' : ''
      if (accio?.takenOver || accio?.launchedByUs) {
        toast.success(`已选择 ${name}`, { description: `下一条请求生效，正在生成的回复不受影响。${windowNote}`, duration: windowNote ? 10_000 : 5000 })
      } else if (accio?.running) {
        toast.warning(`已选择 ${name}，但还没有生效`, {
          description: `当前尚未确认接入。请在总览中接管 Accio，操作会重启它。${windowNote}`,
          action: { label: '查看接入', onClick: () => go('home') },
          duration: 10_000,
        })
      } else {
        toast(`已选择 ${name}`, {
          description: `${accio?.installed ? '通过 Accio BYOK 启动 Accio 后生效。' : '找到 Accio 并通过 Accio BYOK 启动后生效。'}${windowNote}`,
          action: accio?.installed ? { label: '启动 Accio', onClick: () => void takeoverWithToast() } : undefined,
          duration: 8000,
        })
      }
    },
    [state, go],
  )
}

function QuickSwitch() {
  const { state, activeProvider, activeName } = useStore()
  const switchTo = useSwitchProvider()
  if (!state) return <Skeleton className="h-8 w-48" />
  const isOfficial = state.activeProviderId === OFFICIAL_PROVIDER_ID || !activeProvider
  const effect = effectState(state)
  return (
    <PopoverBox
      align="end"
      className="w-80"
      trigger={
        <button
          aria-label={`当前模型来源：${activeName}。${effect.label}`}
          className="no-drag flex h-8 max-w-[360px] items-center gap-2 rounded-full border border-border bg-surface px-1.5 pr-3 text-[12.5px] shadow-sm transition hover:bg-surface-hover"
        >
          {isOfficial ? <OfficialAvatar size={22} /> : <ProviderAvatar presetId={activeProvider.presetId} name={activeProvider.name} size={22} />}
          <span className="truncate font-medium">{activeName}</span>
          {!isOfficial && activeProvider.model ? <span className="truncate font-mono text-[11.5px] text-muted">{activeProvider.model}</span> : null}
          <StatusDot tone={effect.tone} />
          <ChevronDown className="size-3.5 shrink-0 text-subtle" />
        </button>
      }
    >
      <div className="flex items-center gap-2 px-2.5 pt-2 pb-1.5 text-[11.5px] text-muted">
        <StatusDot tone={effect.tone} />
        {effect.label}
      </div>
      <div className="max-h-80 overflow-y-auto">
        {[{ id: OFFICIAL_PROVIDER_ID, name: 'Accio 官方', model: '使用 Accio 自带额度', presetId: undefined }, ...state.providers].map((p) => {
          const active = p.id === state.activeProviderId || (p.id === OFFICIAL_PROVIDER_ID && isOfficial)
          return (
            <PopoverClose asChild key={p.id}>
              <button
                onClick={() => !active && switchTo(p.id, p.name)}
                className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent-soft', active && 'bg-accent-soft')}
              >
                {p.id === OFFICIAL_PROVIDER_ID ? <OfficialAvatar size={28} /> : <ProviderAvatar presetId={p.presetId} name={p.name} size={28} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{p.name}</div>
                  <div className="truncate font-mono text-[11.5px] text-muted">{p.model || '未设置模型'}</div>
                </div>
                {active ? <Check className="size-4 text-accent" /> : null}
              </button>
            </PopoverClose>
          )
        })}
      </div>
    </PopoverBox>
  )
}

function SidebarStatus() {
  const { state, go } = useStore()
  if (!state) return <Skeleton className="h-20 w-full rounded-xl" />
  const { accio, proxy } = state
  const accioTone = !accio.installed ? 'danger' : accio.takenOver ? 'success' : accio.launchedByUs ? 'neutral' : accio.running ? 'warning' : 'neutral'
  const accioText = !accio.installed ? '未找到 Accio' : accio.takenOver ? '代理已收到请求' : accio.launchedByUs ? 'Accio 已启动 · 待验证' : accio.running ? 'Accio 接入未确认' : 'Accio 未运行'
  return (
    <button onClick={() => go('home')} className="no-drag w-full space-y-2 rounded-xl border border-border bg-surface/60 p-3 text-left text-[12px] transition hover:bg-surface">
      <div className="flex items-center gap-2">
        <StatusDot tone={proxy.running ? 'success' : 'danger'} />
        <span className="text-muted">本地代理</span>
        <span className="ml-auto font-mono text-[11.5px] text-fg tabular">{proxy.running ? `:${proxy.port}` : '已停止'}</span>
      </div>
      <div className="flex items-center gap-2">
        <StatusDot tone={accioTone} pulse={accio.takenOver} />
        <span className="text-muted">{accioText}</span>
      </div>
    </button>
  )
}

function RecoveryNotice() {
  const { state, refresh, loadError } = useStore()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  if (loadError) return <div role="alert" className="mb-5 rounded-xl bg-danger-soft p-4 text-[13px] text-danger"><p>读取应用状态失败：{loadError}</p><Button className="mt-3" onClick={() => void refresh().catch(() => {})}>重新读取状态</Button></div>
  if (!state) return null
  const recover = async (action: 'retry' | 'reset') => {
    setBusy(true)
    try { await api.recoverConfig(action); await refresh(); toast.success(action === 'retry' ? '已重新读取配置' : '已保留原文件副本并创建新配置') }
    catch (e) { toast.error('恢复未完成', { description: (e as Error).message }); await refresh() }
    finally { setBusy(false) }
  }
  if (state.configError) return <div role="alert" className="mb-5 rounded-xl border border-danger/30 bg-danger-soft p-4 text-[13px]">
    <p className="font-medium text-danger">配置需要恢复</p><p className="mt-1 leading-relaxed text-muted">{state.configError}</p>
    <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" onClick={() => void api.openPath(state.dataDir)}>打开配置目录</Button><Button size="sm" loading={busy} onClick={() => void recover('retry')}>重新读取</Button><Button size="sm" disabled={busy} onClick={() => setConfirm(true)}>保留副本后重建</Button></div>
    <Confirm open={confirm} onOpenChange={setConfirm} title="保留原文件后重建配置？" description="原 config.json 会先保存为 recovery 副本。新的供应商列表为空，需要重新添加 Key；日志和会话备份保留。无法保存副本时不会重建。" confirmText="保留副本并重建" onConfirm={() => recover('reset')} />
  </div>
  if (state.busyOperation) return <div role="status" className="mb-4 rounded-lg bg-accent-soft px-4 py-3 text-[13px] text-accent">正在{state.busyOperation}…</div>
  if (state.operationError) return <div role="alert" className="mb-4 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] text-warning">上次操作未完成：{state.operationError}</div>
  return null
}

export function App() {
  const { page, go } = useStore()
  return (
    <div className="flex h-full">
      <aside className="flex w-[228px] shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="drag flex h-12 shrink-0 items-center gap-2.5 px-4">
          <AppLogo className="size-6" />
          <span className="font-display text-[14.5px] font-semibold tracking-tight">Accio BYOK</span>
        </div>
        <nav className="mt-2 space-y-0.5 px-2.5" aria-label="主导航">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => go(id)}
              aria-current={page === id ? 'page' : undefined}
              className={cn(
                'no-drag relative flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13.5px] transition',
                page === id ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted hover:bg-surface/60 hover:text-fg',
              )}
            >
              {page === id ? <span className="absolute top-2 bottom-2 left-0 w-[3px] rounded-full bg-accent" /> : null}
              <Icon className={cn('size-[18px]', page === id ? 'text-accent' : '')} strokeWidth={1.8} />
              {label}
            </button>
          ))}
        </nav>
        <div className="mt-auto p-3">
          <SidebarStatus />
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="drag flex h-12 shrink-0 items-center justify-end gap-3 pr-[150px] pl-8">
          <QuickSwitch />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div key={page} className="mx-auto w-full max-w-[1120px] px-8 pt-2 pb-12 animate-pop-in">
            <RecoveryNotice />
            {page === 'home' && <HomePage />}
            {page === 'providers' && <ProvidersPage />}
            {page === 'usage' && <UsagePage />}
            {page === 'sessions' && <SessionsPage />}
            {page === 'settings' && <SettingsPage />}
          </div>
        </div>
      </main>
    </div>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-6">
      <div className="min-w-0">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-[13.5px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
