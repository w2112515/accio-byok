import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { AppState } from '../../../shared/api.ts'
import { OFFICIAL_PROVIDER_ID, type ProviderView, type RequestLog } from '../../../shared/types.ts'
import { api, onAppEvent } from './api.ts'

export type Page = 'home' | 'providers' | 'usage' | 'sessions' | 'settings'

interface Store {
  state: AppState | null
  loadError?: string
  refresh: () => Promise<void>
  page: Page
  go: (page: Page, intent?: string) => void
  intent?: string
  clearIntent: () => void
  logs: RequestLog[]
  activeProvider: ProviderView | undefined
  activeName: string
  /** Accio model code → display name (e.g. 1Helix-… → GPT 5.6 Luna). */
  modelName: (code: string) => string
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const [page, setPage] = useState<Page>('home')
  const [intent, setIntent] = useState<string>()
  const [logs, setLogs] = useState<RequestLog[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const inflight = useRef<Promise<void> | null>(null)
  const dirty = useRef(false)

  // Coalesce refreshes: an event arriving mid-request schedules one more fetch instead of
  // being dropped, so the UI never settles on a state older than the last event.
  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) {
      dirty.current = true
      return inflight.current
    }
    const run = async () => {
      do {
        dirty.current = false
        setState(await api.getState())
        setLoadError(undefined)
      } while (dirty.current)
    }
    inflight.current = run().catch((e) => { setLoadError((e as Error).message); throw e }).finally(() => {
      inflight.current = null
    })
    return inflight.current
  }, [])

  useEffect(() => {
    const refreshSafely = () => void refresh().catch(() => {})
    const readLogs = () => void api.recentLogs(300).then(setLogs).catch((e) => toast.error('读取请求记录失败', { description: e.message }))
    refreshSafely()
    readLogs()
    void api.accioModels().then((list) => setNames(Object.fromEntries(list.map((m) => [m.code, m.name])))).catch((e) => toast.error('读取 Accio 模型目录失败', { description: e.message }))
    return onAppEvent((e) => {
      if (e.type === 'storage-error') toast.error('用量日志写入失败', { description: e.message })
      else if (e.type === 'log') setLogs((prev) => [e.entry, ...prev].slice(0, 300))
      else if (e.type === 'navigate') {
        setPage(e.page)
        setIntent(e.intent)
      } else if (e.type === 'config') {
        refreshSafely()
        readLogs()
      } else refreshSafely()
    })
  }, [refresh])

  const activeProvider = state?.providers.find((p) => p.id === state.activeProviderId)
  const value = useMemo<Store>(
    () => ({
      state,
      loadError,
      refresh,
      page,
      go: (p, i) => {
        setPage(p)
        setIntent(i)
      },
      intent,
      clearIntent: () => setIntent(undefined),
      logs,
      activeProvider,
      activeName: state?.activeProviderId === OFFICIAL_PROVIDER_ID || !activeProvider ? 'Accio 官方' : activeProvider.name,
      modelName: (code) => names[code] ?? code,
    }),
    [state, loadError, refresh, page, intent, logs, activeProvider, names],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('StoreProvider missing')
  return s
}

/** Re-render periodically so relative times stay fresh. */
export function useTicker(ms = 15_000): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), ms)
    return () => clearInterval(t)
  }, [ms])
  return n
}
