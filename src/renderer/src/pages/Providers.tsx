import { getLanguage, tr } from '../../../shared/i18n.ts'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  KeyRound,
  ListFilter,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wifi,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CATEGORY_LABELS, PRESETS, findPreset, type PresetCategory, type ProviderPreset } from '../../../shared/presets.ts'
import { inferProviderKind, normalizeBaseUrl } from '../../../shared/provider-input.ts'
import { knownModelInfo } from '../../../shared/model-info.ts'
import {
  OFFICIAL_PROVIDER_ID,
  type AccioModelInfo,
  type ProviderInput,
  type ProviderKind,
  type ProviderView,
  type RequestLog,
  type TestResult,
  type TestScope,
  type ModelInfo,
  type ThinkingMode,
  type UsageStats,
} from '../../../shared/types.ts'
import { effectState, PageHeader, StartAccioButton, useSwitchProvider } from '../App.tsx'
import { KIND_LABEL, KindBadge, OfficialAvatar, ProviderAvatar } from '../components/brand.tsx'
import { ConnectionStatus } from '../components/ConnectionStatus.tsx'
import {
  Badge,
  Button,
  Card,
  Confirm,
  Field,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Modal,
  PopoverBox,
  PopoverClose,
  SecretInput,
  Segmented,
  SelectBox,
  Switch,
  Textarea,
} from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { cn, fmtCost, fmtDateTime, fmtMs, fmtTokens, hostOf, timeAgo } from '../lib/format.ts'
import { useStore, useTicker } from '../lib/store.tsx'

// ---------------------------------------------------------------------------
// Draft <-> input

interface Draft {
  id?: string
  presetId?: string
  name: string
  kind: ProviderKind
  openaiApi: 'chat' | 'responses'
  allowInsecureHttp: boolean
  baseUrl: string
  apiKey: string
  keyTouched: boolean
  hasKey: boolean
  keyMasked: string
  model: string
  overrides: { from: string; to: string }[]
  maxOutputTokens: string
  sendReasoningEffort: boolean
  sendReasoningContent: boolean
  thinking: ThinkingMode
  thinkingBudget: string
  promptCaching: boolean
  sendSampling: boolean
  headersText: string
  priceIn: string
  priceOut: string
  priceCached: string
  priceWrite: string
  pricingModel: string
  pricingUpdatedAt?: number
  modelInfo?: ModelInfo
}

const num = (s: string) => {
  if (!s.trim()) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) throw new Error(tr("Token 与价格必须填写有效的非负数字"))
  return n
}

function fromPreset(p: ProviderPreset): Draft {
  const d = p.defaults
  return {
    presetId: p.id,
    name: p.category === 'custom' ? '' : p.name,
    kind: p.kind,
    openaiApi: d.openaiApi ?? 'chat',
    allowInsecureHttp: false,
    baseUrl: p.baseUrl,
    apiKey: '',
    keyTouched: true,
    hasKey: false,
    keyMasked: '',
    model: d.model ?? '',
    overrides: [],
    maxOutputTokens: d.maxOutputTokens ? String(d.maxOutputTokens) : '',
    sendReasoningEffort: d.sendReasoningEffort ?? false,
    sendReasoningContent: d.sendReasoningContent ?? false,
    thinking: d.thinking ?? 'off',
    thinkingBudget: d.thinkingBudget ? String(d.thinkingBudget) : '8000',
    promptCaching: d.promptCaching ?? false,
    sendSampling: d.sendSampling ?? true,
    headersText: '',
    priceIn: d.pricing?.input !== undefined ? String(d.pricing.input) : '',
    priceOut: d.pricing?.output !== undefined ? String(d.pricing.output) : '',
    priceCached: d.pricing?.cachedInput !== undefined ? String(d.pricing.cachedInput) : '',
    priceWrite: d.pricing?.cacheWriteInput !== undefined ? String(d.pricing.cacheWriteInput) : '',
    pricingModel: d.model ?? '',
    pricingUpdatedAt: d.pricing ? knownModelInfo(p.kind, p.baseUrl, d.model ?? '')?.checkedAt : undefined,
    modelInfo: knownModelInfo(p.kind, p.baseUrl, d.model ?? ''),
  }
}

function fromView(v: ProviderView): Draft {
  return {
    id: v.id,
    presetId: v.presetId,
    name: v.name,
    kind: v.kind,
    openaiApi: v.openaiApi ?? 'chat',
    allowInsecureHttp: v.allowInsecureHttp ?? false,
    baseUrl: v.baseUrl,
    apiKey: '',
    keyTouched: false,
    hasKey: v.hasApiKey,
    keyMasked: v.apiKeyMasked,
    model: v.model,
    overrides: Object.entries(v.modelOverrides ?? {}).map(([from, to]) => ({ from, to })),
    maxOutputTokens: v.maxOutputTokens ? String(v.maxOutputTokens) : '',
    sendReasoningEffort: v.sendReasoningEffort ?? false,
    sendReasoningContent: v.sendReasoningContent ?? false,
    thinking: v.thinking ?? 'off',
    thinkingBudget: String(v.thinkingBudget ?? 8000),
    promptCaching: v.promptCaching ?? false,
    sendSampling: v.sendSampling ?? false,
    headersText: Object.entries(v.extraHeaders ?? {})
      .map(([k, val]) => `${k}: ${val}`)
      .join('\n'),
    priceIn: v.pricing?.input !== undefined ? String(v.pricing.input) : '',
    priceOut: v.pricing?.output !== undefined ? String(v.pricing.output) : '',
    priceCached: v.pricing?.cachedInput !== undefined ? String(v.pricing.cachedInput) : '',
    priceWrite: v.pricing?.cacheWriteInput !== undefined ? String(v.pricing.cacheWriteInput) : '',
    pricingModel: v.pricingModel ?? v.model,
    pricingUpdatedAt: v.pricingUpdatedAt,
    modelInfo: v.modelInfo,
  }
}

function toInput(d: Draft): ProviderInput {
  const headers: Record<string, string> = {}
  for (const line of d.headersText.split('\n')) {
    if (!line.trim()) continue
    const i = line.indexOf(':')
    if (i <= 0) throw new Error(tr("自定义请求头应为「名称: 值」，每行一个"))
    headers[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  const pricing = { input: num(d.priceIn), output: num(d.priceOut), cachedInput: num(d.priceCached), cacheWriteInput: num(d.priceWrite) }
  return {
    id: d.id,
    presetId: d.presetId,
    name: d.name,
    kind: d.kind,
    openaiApi: d.openaiApi,
    allowInsecureHttp: d.allowInsecureHttp,
    baseUrl: d.baseUrl,
    apiKey: d.keyTouched ? d.apiKey : undefined,
    model: d.model,
    modelOverrides: Object.fromEntries(d.overrides.filter((o) => o.from && o.to).map((o) => [o.from, o.to])),
    maxOutputTokens: num(d.maxOutputTokens),
    sendReasoningEffort: d.sendReasoningEffort,
    sendReasoningContent: d.sendReasoningContent,
    thinking: d.thinking,
    thinkingBudget: num(d.thinkingBudget),
    promptCaching: d.promptCaching,
    sendSampling: d.sendSampling,
    extraHeaders: headers,
    pricing: Object.values(pricing).some((v) => v !== undefined) ? pricing : undefined,
    pricingModel: d.pricingModel,
    pricingUpdatedAt: d.pricingUpdatedAt,
    modelInfo: d.modelInfo?.model === d.model.trim() ? d.modelInfo : knownModelInfo(d.kind, d.baseUrl, d.model.trim()),
  }
}

// ---------------------------------------------------------------------------
// Preset gallery

function PresetGallery({ onPick }: { onPick: (p: ProviderPreset) => void }) {
  const [q, setQ] = useState('')
  const language = getLanguage()
  const groups = useMemo(() => {
    const k = q.trim().toLowerCase()
    const list = PRESETS.filter((p) => !p.hidden && (!k || `${p.name} ${p.description} ${p.baseUrl}`.toLowerCase().includes(k)))
    return (Object.keys(CATEGORY_LABELS) as PresetCategory[]).map((c) => ({ c, items: list.filter((p) => p.category === c) })).filter((g) => g.items.length)
  }, [q, language])
  return (
    <div>
      <div className="relative mb-5">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tr("搜索供应商…")} className="pl-9" aria-label={tr("搜索供应商")} />
      </div>
      <div className="space-y-5">
        {groups.map(({ c, items }) => (
          <section key={c}>
            <h4 className="mb-2 text-[12px] font-medium text-subtle">{CATEGORY_LABELS[c]}</h4>
            <div className="grid grid-cols-2 gap-2.5">
              {items.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onPick(p)}
                  className="group flex items-start gap-3 rounded-xl border border-border bg-surface p-3 text-left transition hover:-translate-y-px hover:border-accent/40 hover:shadow-card"
                >
                  <ProviderAvatar presetId={p.id} name={p.name} size={34} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{p.name}</span>
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted">{p.description}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
        {!groups.length ? <div className="py-10 text-center text-[13px] text-subtle">{tr("没有匹配的接入方式，可以清空搜索后选择「通用中转站」。")}</div> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model picker

function ModelPicker({ draft, value, onChange, id, placeholder }: { draft: Draft; value: string; onChange: (v: string) => void; id?: string; placeholder?: string }) {
  const { logs } = useStore()
  const [models, setModels] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const hints = findPreset(draft.presetId)?.modelHints ?? []
  const connection = JSON.stringify([draft.id, draft.kind, draft.openaiApi, draft.baseUrl, draft.apiKey, draft.keyTouched, draft.headersText, draft.allowInsecureHttp])
  const latest = useRef(connection)
  latest.current = connection
  const request = useRef(0)
  useEffect(() => {
    request.current++
    setModels(null)
    setLoading(false)
    setFilter('')
    return () => { request.current++ }
  }, [connection])
  const load = async (refresh = false) => {
    const version = ++request.current
    const current = () => version === request.current && connection === latest.current
    setLoading(true)
    try {
      const list = await api.listProviderModels(toInput(draft), refresh)
      if (!current()) return
      setModels(list)
      if (!list.length) toast(tr("接口没有返回模型列表，请手动填写"))
    } catch (e) {
      if (!current()) return
      toast.error(tr("获取模型列表失败"), { description: (e as Error).message })
      setModels(null)
    } finally {
      if (current()) setLoading(false)
    }
  }
  const recent = new Set(logs.filter((l) => l.providerId === draft.id && l.status === 'ok').map((l) => l.targetModel))
  const shown = (models ?? []).filter((m) => m.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => Number(recent.has(b)) - Number(recent.has(a))).slice(0, 300)
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? tr("例如 deepseek-chat")} className="font-mono" spellCheck={false} />
        <PopoverBox
          align="end"
          className="w-80 p-0"
          trigger={
            <Button type="button" onClick={() => !models && !loading && void load()} className="shrink-0">
              {loading ? <Loader2 className="animate-spin" /> : <ListFilter />}
              {tr("模型列表")}</Button>
          }
        >
          <div className="border-b border-border p-2">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={models ? tr("筛选 {0} 个模型", models.length) : tr("加载中…")} autoFocus aria-label={tr("筛选模型")} />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted">
                <Loader2 className="size-4 animate-spin" /> {tr(" 正在向供应商请求…")}</div>
            ) : shown.length ? (
              shown.map((m) => (
                <PopoverClose asChild key={m}>
                  <button onClick={() => onChange(m)} className={cn('flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[12.5px] hover:bg-accent-soft', m === value && 'text-accent')}>
                    <span className="truncate">{m}{recent.has(m) ? <span className="ml-2 font-sans text-[10px] text-subtle">{tr("最近成功")}</span> : null}</span>
                    {m === value ? <Check className="size-3.5 shrink-0" /> : null}
                  </button>
                </PopoverClose>
              ))
            ) : (
              <div className="py-8 text-center text-[12.5px] text-subtle">{models ? tr("没有匹配的模型") : tr("需要先填写接口地址和 Key")}</div>
            )}
          </div>
          <div className="flex justify-end border-t border-border p-1.5">
            <Button variant="ghost" size="sm" onClick={() => void load(true)} loading={loading}>
              {tr("重新获取")}</Button>
          </div>
        </PopoverBox>
      </div>
      {hints.length ? (
        <div className="flex flex-wrap gap-1.5">
          {hints.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => onChange(h)}
              className={cn('rounded-md border px-2 py-0.5 font-mono text-[11.5px] transition', h === value ? 'border-accent/50 bg-accent-soft text-accent' : 'border-border text-muted hover:text-fg')}
            >
              {h}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editor

function Section({ title, description, children, defaultOpen = false }: { title: string; description?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border border-border">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
        <div>
          <div className="text-[13px] font-medium">{title}</div>
          {description ? <div className="text-[12px] text-subtle">{description}</div> : null}
        </div>
        <ChevronDown className={cn('size-4 text-subtle transition-transform', open && 'rotate-180')} />
      </button>
      {open ? <div className="space-y-4 border-t border-border px-4 py-4">{children}</div> : null}
    </div>
  )
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="text-[13px]">{label}</div>
        {hint ? <div className="text-[12px] leading-relaxed text-subtle">{hint}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} label={label} />
    </div>
  )
}

function ProviderEditor({ open, onOpenChange, initial }: { open: boolean; onOpenChange: (v: boolean) => void; initial: ProviderView | 'new' | null }) {
  const { state, logs } = useStore()
  const [step, setStep] = useState<'preset' | 'form' | 'ready'>('preset')
  const [ready, setReady] = useState<{ provider: ProviderView; at: number } | null>(null)
  const [formError, setFormError] = useState<string>()
  const [readingInfo, setReadingInfo] = useState(false)
  const [infoMessage, setInfoMessage] = useState<string>()
  const infoOperation = useRef(0)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)
  const [accioModels, setAccioModels] = useState<AccioModelInfo[]>([])
  const switchTo = useSwitchProvider()
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const operation = useRef(0)

  useEffect(() => {
    operation.current++
    infoOperation.current++
    setReadingInfo(false)
    setInfoMessage(undefined)
    setTesting(false)
    setSaving(false)
    if (!open) return
    setTest(null)
    setReady(null)
    setFormError(undefined)
    if (initial === 'new' || initial === null) {
      setStep('preset')
      setDraft(null)
    } else {
      setStep('form')
      setDraft(fromView(initial))
    }
    void api.accioModels().then(setAccioModels).catch(() => setAccioModels([]))
  }, [open, initial])
  useEffect(() => { setTest(null); setFormError(undefined) }, [draft])

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => {
    if (!d) return d
    return {
      ...d, [k]: v,
      ...(['kind', 'openaiApi', 'baseUrl', 'headersText'].includes(k) ? { modelInfo: undefined } : {}),
      ...(k === 'baseUrl' ? { allowInsecureHttp: false } : {}),
      ...(['priceIn', 'priceOut', 'priceCached', 'priceWrite'].includes(k) ? { pricingModel: d.model.trim(), pricingUpdatedAt: Date.now() } : {}),
    }
  })
  const preset = findPreset(draft?.presetId)
  const modelInfo = draft ? draft.modelInfo?.model === draft.model.trim() ? draft.modelInfo : knownModelInfo(draft.kind, draft.baseUrl, draft.model.trim()) : undefined
  const readInfo = async () => {
    if (!draft) return
    const currentDraft = draft
    const version = ++infoOperation.current
    setReadingInfo(true)
    setInfoMessage(undefined)
    try {
      const info = await api.providerModelInfo(toInput(draft))
      if (version !== infoOperation.current || latestDraft.current !== currentDraft) return
      if (info) { setDraft({ ...draft, modelInfo: info }); setInfoMessage(tr("已读取接口提供的信息；这不代表能力已经实测。")) }
      else setInfoMessage(tr("该接口未提供可用的模型元数据，可依据供应商文档手动填写。"))
    } catch (e) {
      if (version === infoOperation.current && latestDraft.current === currentDraft) setInfoMessage(tr("读取失败：{0}。已填写的信息保留。", (e as Error).message))
    } finally { if (version === infoOperation.current) setReadingInfo(false) }
  }
  const setWindow = (value: string) => {
    if (!draft) return
    setDraft({ ...draft, modelInfo: { ...modelInfo, model: draft.model.trim(), contextWindow: value ? Number(value) : undefined, windowKind: 'context', source: 'user', sourceUrl: undefined, checkedAt: Date.now() } })
  }
  const isNew = (initial === 'new' || initial === null) && !draft?.id
  let urlError: string | undefined
  if (draft) {
    try { normalizeBaseUrl(draft.kind, draft.baseUrl) } catch (e) { urlError = (e as Error).message }
  }
  const normalizeAddress = () => {
    if (!draft) return
    const kind = inferProviderKind(draft.baseUrl) ?? draft.kind
    try {
      const baseUrl = normalizeBaseUrl(kind, draft.baseUrl)
      const pathname = new URL(draft.baseUrl).pathname
      const openaiApi = /\/responses\/?$/.test(pathname) ? 'responses' : /\/chat\/completions\/?$/.test(pathname) ? 'chat' : draft.openaiApi
      if (kind !== draft.kind || baseUrl !== draft.baseUrl || openaiApi !== draft.openaiApi) setDraft({ ...draft, kind, baseUrl, openaiApi, modelInfo: undefined })
    } catch { /* keep the user's input and show its validation message */ }
  }

  const save = async () => {
    if (!draft || urlError || !draft.model.trim()) return
    setSaving(true)
    try {
      const saved = await api.saveProvider(toInput(draft))
      toast.success(isNew ? tr("已添加 {0}", saved.name) : tr("已保存"), {
        action: isNew ? { label: tr("立即使用"), onClick: () => void switchTo(saved.id, saved.name) } : undefined,
      })
      onOpenChange(false)
    } catch (e) {
      setFormError((e as Error).message)
      toast.error(tr("保存失败"), { description: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const runTest = async (activate = false, scope: TestScope = 'text') => {
    if (!draft) return
    const version = ++operation.current
    const current = () => operation.current === version && latestDraft.current === draft
    setTesting(true)
    setTest(null)
    try {
      const input = toInput(draft)
      const result = await api.testProvider(input, scope)
      if (!current()) return
      setTest(result)
      if (activate && result.ok) {
        setSaving(true)
        const saved = await api.saveProvider(input, true)
        setReady({ provider: saved, at: Date.now() })
        setDraft(fromView(saved))
        setStep('ready')
      }
    } catch (e) {
      if (current()) setTest({ ok: false, latencyMs: 0, model: draft.model, message: (e as Error).message })
    } finally {
      if (operation.current === version) { setTesting(false); setSaving(false) }
    }
  }

  const accioOptions = accioModels
    .filter((m) => m.visible || draft?.overrides.some((o) => o.from === m.code))
    .map((m) => ({ value: m.code, label: m.name, description: m.code }))

  return (
    <Modal
      open={open}
      onOpenChange={(v) => { if (!saving) onOpenChange(v) }}
      className="w-[min(680px,calc(100vw-48px))]"
      title={
        step === 'ready' ? tr("模型已保存并选择") : step === 'preset' ? (
          tr("选择接入方式")
        ) : (
          <span className="flex items-center gap-2.5">
            {isNew && !draft?.id ? (
              <Button variant="ghost" size="icon-sm" disabled={saving} onClick={() => { operation.current++; setTesting(false); setTest(null); setStep('preset') }} aria-label={tr("返回")}>
                <ArrowLeft />
              </Button>
            ) : null}
            {isNew ? tr("添加 {0}", preset?.category === 'custom' ? tr("自定义供应商") : (preset?.name ?? '')) : tr("编辑 {0}", draft?.name ?? '')}
          </span>
        )
      }
      description={step === 'preset' ? tr("从预设开始，地址和推荐参数会自动填好。") : undefined}
      footer={
        step === 'ready' ? <><Button onClick={() => setStep('form')}>{tr("调整配置")}</Button><Button onClick={() => onOpenChange(false)}>{tr("完成")}</Button></> : step === 'form' && draft ? (
          <div className="w-full space-y-3">
            {test?.protection ? <ConnectionStatus value={test.protection} /> : null}
            {formError ? <p role="alert" className="max-h-24 overflow-y-auto rounded-lg bg-danger-soft p-3 text-[12.5px] text-danger">{formError}</p> : null}
            {testing || test ? <div role="status" className={cn('max-h-28 overflow-y-auto rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed break-words', test ? test.ok ? 'border-success/30 text-success' : 'border-danger/30 text-danger' : 'border-border text-muted')}>
              {testing ? tr("正在测试提交时的配置…修改配置后，本次结果不再适用。") : <>{test?.scope ? `${{ text: tr("短文本"), tools: tr("工具调用"), image: tr("图片识别") }[test.scope]} · ` : ''}{test?.checkedAt ? `${fmtDateTime(test.checkedAt)} · ` : ''}{test?.ok ? tr("通过 · {0} · {1}", fmtMs(test.latencyMs), test.message) : test?.message}</>}
            </div> : null}
            <div className="flex justify-end gap-2">
            <Button onClick={() => void runTest()} disabled={saving || testing || !!urlError || !draft.model.trim()}>
              <Wifi />
              {tr("测试")}</Button>
            <Button onClick={save} disabled={saving || testing || !!urlError || !draft.model.trim()}>
              {tr("仅保存")}</Button>
            <Button variant="primary" onClick={() => void runTest(true)} loading={saving || testing} disabled={!!urlError || !draft.model.trim()}>
              {tr("测试并启用")}</Button>
            </div>
          </div>
        ) : undefined
      }
    >
      {step === 'ready' && ready ? (
        <div className="space-y-5">
          <div className="rounded-xl border border-success/30 bg-success-soft p-4"><p className="text-[14px] font-medium text-success">{tr("短文本连接测试通过")}</p><p className="mt-1 text-[13px] text-muted">{ready.provider.name} · <span className="font-mono">{ready.provider.model}</span></p><p className="mt-2 text-[12px] leading-relaxed text-muted">{tr("工具、图像和长会话能力需要分别验证。当前选择会应用于下一条请求。")}</p></div>
          <div className="space-y-3"><p className="text-[14px] font-medium">{state?.accio.takenOver || state?.accio.launchedByUs ? tr("下一步：在 Accio 中发一条消息") : tr("下一步：启动并接入 Accio")}</p><p className="text-[13px] leading-relaxed text-muted">{state?.accio.running && !state.accio.takenOver && !state.accio.launchedByUs ? tr("接入需要重启 Accio，正在进行的任务会中断。") : tr("真实调用后，可在总览和用量页看到实际模型与调用结果。")}</p><StartAccioButton /></div>
          {logs.some((l) => l.providerId === ready.provider.id && l.ts >= ready.at && l.status === 'ok') ? <p role="status" className="text-[13px] text-success">{tr("已观察到该供应商的成功请求。")}</p> : null}
        </div>
      ) : step === 'preset' ? (
        <PresetGallery
          onPick={(p) => {
            setDraft(fromPreset(p))
            setStep('form')
          }}
        />
      ) : draft ? (
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label={tr("名称")} htmlFor="pv-name">
              <Input id="pv-name" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder={preset?.name ?? tr("给它起个名字")} />
            </Field>
            <Field label={tr("接口类型")}>
              <Segmented
                label={tr("接口类型")}
                value={draft.kind}
                onChange={(v) => set('kind', v)}
                options={(['openai', 'anthropic', 'gemini'] as ProviderKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                className="w-full [&>button]:flex-1"
              />
            </Field>
          </div>
          {draft.kind === 'openai' ? <Field label={tr("OpenAI 接口协议")} hint={tr("Codex 类分组通常使用 Responses；以网关提供的接入说明为准。")}>
            <Segmented label={tr("OpenAI 接口协议")} value={draft.openaiApi} onChange={(v) => set('openaiApi', v)} options={[{ value: 'chat', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }]} />
          </Field> : null}
          <Field
            label={tr("接口地址")}
            htmlFor="pv-url"
            error={urlError}
            hint={tr("可粘贴基础地址或完整接口地址，离开输入框后自动识别协议并整理路径。")}
          >
            <Input id="pv-url" value={draft.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} onBlur={normalizeAddress} className="font-mono" spellCheck={false} />
          </Field>
          {preset?.category === 'relay' ? <div className="rounded-lg border border-border bg-fg/[0.025] px-3 py-2.5 text-[12px] leading-relaxed text-muted">
            <p>{tr("填写已部署网关的客户端 API Key，不要填写管理密钥、订阅账号登录令牌或 Cookie。中转服务能够接触你的请求内容，账号限制仍取决于服务方规则。")}</p>
            {preset.docsUrl ? <button type="button" className="mt-1 inline-flex items-center gap-1 text-accent hover:underline" onClick={() => void api.openExternal(preset.docsUrl!)}>{tr("项目接入说明 ")}<ExternalLink className="size-3" /></button> : null}
          </div> : null}
          <Field
            label={
              <span className="flex items-center justify-between">
                API Key
                {preset?.keyUrl ? (
                  <button type="button" onClick={() => void api.openExternal(preset.keyUrl!)} className="inline-flex items-center gap-1 text-[12px] font-normal text-accent hover:underline">
                    {tr("获取 Key ")}<ExternalLink className="size-3" />
                  </button>
                ) : null}
              </span>
            }
            htmlFor="pv-key"
            hint={preset?.category === 'local' ? tr("本地模型通常不需要 Key，可以留空。") : tr("使用 Windows 数据保护加密保存在本机，界面上只显示前后几位。")}
          >
            <SecretInput
              id="pv-key"
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => (d ? { ...d, apiKey: e.target.value, keyTouched: true, modelInfo: undefined } : d))}
              placeholder={draft.hasKey && !draft.keyTouched ? tr("已保存 {0}（留空保持不变）", draft.keyMasked) : 'sk-…'}
            />
          </Field>
          <Field label={tr("默认模型")} htmlFor="pv-model" hint={tr("Accio 里选择的任何模型都会被替换成它，除非在下方单独映射。")}>
            <ModelPicker id="pv-model" draft={draft} value={draft.model} onChange={(v) => set('model', v)} />
          </Field>
          <div className="rounded-lg border border-border bg-fg/[0.025] px-3 py-2.5 text-[12px] leading-relaxed text-muted">
            <p>{modelInfo?.windowKind === 'input' ? tr("输入上限") : tr("上下文窗口")}：{modelInfo?.contextWindow ? `${fmtTokens(modelInfo.contextWindow)} Token` : tr("未知")} {tr(" · 最大输出：")}{modelInfo?.maxOutputTokens ? `${fmtTokens(modelInfo.maxOutputTokens)} Token` : tr("未知")}</p>
            <p>{tr("工具：")}{modelInfo?.tools === undefined ? tr("未确认") : modelInfo.tools ? tr("资料支持") : tr("资料不支持")} {tr(" · 图像：")}{modelInfo?.vision === undefined ? tr("未确认") : modelInfo.vision ? tr("资料支持") : tr("资料不支持")}</p>
            {modelInfo ? <p className="mt-1 text-subtle">{tr("来源：")}{{ official: tr("官方资料"), api: tr("供应商接口"), user: tr("手动填写") }[modelInfo.source]} · {fmtDateTime(modelInfo.checkedAt)}{modelInfo.sourceUrl ? <button type="button" className="ml-2 text-accent hover:underline" onClick={() => void api.openExternal(modelInfo.sourceUrl!)}>{tr("查看来源")}</button> : null}</p> : <p className="mt-1 text-subtle">{tr("短文本通过不代表工具和图像可用；可展开下方模型信息核对。")}</p>}
          </div>
          <p className="text-[12px] leading-relaxed text-subtle">{tr("模型列表缓存 5 分钟。连接测试只验证短文本，最多请求 1024 个输出 Token，不额外开启思考，可能产生费用。检测费用不计入 Accio 请求统计。")}</p>
          {initial && initial !== 'new' && initial.keyError && !draft.keyTouched ? <p role="alert" className="text-[12.5px] text-danger">{initial.keyError}</p> : null}
          <Section title={tr("可选能力检测")} description={tr("需要工具或图片功能时分别检查；不会自动调用")}>
            <p className="text-[12px] leading-relaxed text-subtle">{tr("每次发送一个最多 1024 输出 Token 的请求，可能收费。工具检测只要求返回固定参数，不执行操作；图片检测只发送内置的红色方块。结果仅对应本次配置，不代表长会话或完整工具循环已经通过。")}</p>
            <div className="flex gap-2"><Button size="sm" disabled={saving || testing || !!urlError || !draft.model.trim()} onClick={() => void runTest(false, 'tools')}>{tr("检测工具调用")}</Button><Button size="sm" disabled={saving || testing || !!urlError || !draft.model.trim()} onClick={() => void runTest(false, 'image')}>{tr("检测图片识别")}</Button></div>
          </Section>

          <Section title={tr("模型信息与窗口")} description={tr("读取供应商元数据，或依据文档填写；只适用于当前默认模型")}>
            <div className="flex flex-wrap items-center gap-3"><Button type="button" size="sm" loading={readingInfo} disabled={!draft.model.trim() || !!urlError} onClick={() => void readInfo()}>{tr("读取模型信息")}</Button><span className="text-[12px] text-subtle">{tr("读取元数据，不发送生成请求；缓存 5 分钟。")}</span></div>
            {infoMessage ? <p role="status" className="text-[12px] leading-relaxed text-muted">{infoMessage}</p> : null}
            <Field label={tr("上下文窗口 Token")} htmlFor="pv-context" hint={tr("手动填写会标记为用户提供。未知可留空；它不会改变 Accio 的自动压缩阈值。")}>
              <Input id="pv-context" value={modelInfo?.contextWindow ?? ''} onChange={(e) => setWindow(e.target.value.replace(/[^\d]/g, ''))} placeholder={tr("未知")} className="w-48 tabular" />
            </Field>
            {modelInfo?.maxOutputTokens ? <Button size="sm" onClick={() => set('maxOutputTokens', String(Math.min(Number(draft.maxOutputTokens) || 16384, modelInfo.maxOutputTokens!)))}>{tr("按已知输出上限调整")}</Button> : null}
            {modelInfo?.thinking && draft.kind === 'anthropic' ? <Button size="sm" onClick={() => set('thinking', modelInfo.thinking!)}>{tr("采用资料建议的思考模式")}</Button> : null}
            <p className="text-[12px] leading-relaxed text-subtle">{tr("每条模型映射可能指向不同的模型，不能共用这里的窗口。切换到较小窗口前，应先在 Accio 中整理会话或新建会话。")}</p>
          </Section>

          <Section title={tr("模型映射")} description={draft.overrides.length ? tr("{0} 条规则", draft.overrides.length) : tr("按 Accio 里选的模型分别指定目标，例如把轻量模型映射到便宜的模型")}>
            {draft.overrides.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <SelectBox
                    label={tr("Accio 模型")}
                    value={o.from || undefined}
                    onChange={(v) => set('overrides', draft.overrides.map((x, j) => (j === i ? { ...x, from: v } : x)))}
                    options={accioOptions.length ? accioOptions : [{ value: o.from || 'auto', label: o.from || 'auto' }]}
                    placeholder={tr("Accio 中选择的模型")}
                  />
                </div>
                <span className="text-subtle">→</span>
                <div className="min-w-0 flex-1">
                  <Input value={o.to} onChange={(e) => set('overrides', draft.overrides.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} placeholder={tr("目标模型")} className="font-mono" aria-label={tr("目标模型")} />
                </div>
                <Button variant="ghost" size="icon-sm" aria-label={tr("删除映射")} onClick={() => set('overrides', draft.overrides.filter((_, j) => j !== i))}>
                  <X />
                </Button>
              </div>
            ))}
            <Button size="sm" onClick={() => set('overrides', [...draft.overrides, { from: '', to: '' }])}>
              <Plus />
              {tr("添加映射")}</Button>
          </Section>

          <Section title={tr("高级参数")} description={tr("输出长度、思考、缓存、采样和自定义请求头")}>
            <p className="text-[12px] leading-relaxed text-muted">{tr("连接保护：相同地址与凭据最多 4 个并发请求；HTTP 429 后按 Retry-After 等待（缺失时 60 秒）。不会自动重试、切换账户或跟随接口重定向。这些措施不能保证账号不受限。")}</p>
            {/^http:\/\//i.test(draft.baseUrl) ? <ToggleRow label={tr("允许远程 HTTP")} hint={tr("仅在你了解风险时开启：本机以外的 HTTP 会明文传输 Key 和会话。优先使用 HTTPS。本机服务不需要开启。")} checked={draft.allowInsecureHttp} onChange={(v) => set('allowInsecureHttp', v)} /> : null}
            <p className="text-[12px] leading-relaxed text-subtle">{tr("自动压缩由 Accio 管理，依据它所选模型的上下文窗口。BYOK 热切换不会同步该阈值；目标模型窗口较小时，建议先压缩或新建会话。提示缓存节省重复输入成本，不会扩大上下文窗口。")}</p>
            <Field label={tr("最大输出 Token")} htmlFor="pv-max" hint={tr("留空则沿用 Accio 的请求值（通常 16384）。部分模型上限较低，如 8192。")}>
              <Input id="pv-max" value={draft.maxOutputTokens} onChange={(e) => set('maxOutputTokens', e.target.value.replace(/[^\d]/g, ''))} placeholder={tr("沿用 Accio")} className="w-48 tabular" />
            </Field>
            <ToggleRow label={tr("转发推理强度")} hint={tr("把 Accio 里选择的推理强度（低/中/高）传给模型。旧模型可能不支持这个参数。")} checked={draft.sendReasoningEffort} onChange={(v) => set('sendReasoningEffort', v)} />
            {draft.kind === 'openai' && draft.openaiApi !== 'responses' ? (
              <ToggleRow label={tr("回传思考内容")} hint={tr("以 reasoning_content 字段回传历史思考，DeepSeek、Kimi 等思考模型在工具调用时需要。")} checked={draft.sendReasoningContent} onChange={(v) => set('sendReasoningContent', v)} />
            ) : null}
            {draft.kind === 'anthropic' ? (
              <>
                <Field label={tr("思考模式")}>
                  <Segmented
                    label={tr("思考模式")}
                    value={draft.thinking}
                    onChange={(v) => set('thinking', v)}
                    options={[
                      { value: 'off', label: tr("不指定") },
                      { value: 'adaptive', label: tr("自适应") },
                      { value: 'budget', label: tr("固定预算") },
                    ]}
                  />
                </Field>
                {draft.thinking === 'budget' ? (
                  <Field label={tr("思考预算 Token")} htmlFor="pv-budget" hint={tr("适用于不支持自适应思考的旧模型，最少 1024。")}>
                    <Input id="pv-budget" value={draft.thinkingBudget} onChange={(e) => set('thinkingBudget', e.target.value.replace(/[^\d]/g, ''))} className="w-48 tabular" />
                  </Field>
                ) : null}
                <ToggleRow label={tr("提示缓存")} hint={tr("为系统提示和对话添加缓存断点。相同前缀才可能命中；压缩历史、修改工具或思考参数可能使缓存失效。首次写入也计费。")} checked={draft.promptCaching} onChange={(v) => set('promptCaching', v)} />
              </>
            ) : null}
            <ToggleRow label={tr("转发采样参数")} hint={tr("转发 temperature / top_p。较新的 Claude 和推理模型会拒绝这些参数。")} checked={draft.sendSampling} onChange={(v) => set('sendSampling', v)} />
            <Field label={tr("自定义请求头")} htmlFor="pv-headers" hint={tr("每行一个，格式为「名称: 值」。保存时随 Key 加密；此编辑区会显示原值。禁止 Cookie 和传输控制头。")}>
              <Textarea id="pv-headers" value={draft.headersText} onChange={(e) => set('headersText', e.target.value)} placeholder="X-Custom-Header: value" className="font-mono text-[12.5px]" rows={3} spellCheck={false} />
            </Field>
          </Section>

          <Section title={tr("价格")} description={tr("填写后用量页会估算花费（美元 / 百万 Token）")}>
            <p className="text-[12px] leading-relaxed text-muted">{tr("单价用于 ")}<span className="font-mono">{draft.pricingModel || tr("尚未指定的模型")}</span>{draft.pricingUpdatedAt ? tr(" · 更新于 {0}", fmtDateTime(draft.pricingUpdatedAt)) : tr(" · 更新时间未记录")}{tr("。模型映射不会套用默认模型单价。")}</p>
            {draft.pricingModel !== draft.model.trim() && [draft.priceIn, draft.priceOut, draft.priceCached, draft.priceWrite].some(Boolean) ? <div className="space-y-2 rounded-lg bg-warning-soft p-3 text-[12px] text-warning"><p>{tr("这些单价属于其他模型，当前模型的费用将显示为未知。请核对后填写或确认沿用。")}</p><Button size="sm" onClick={() => setDraft({ ...draft, pricingModel: draft.model.trim(), pricingUpdatedAt: Date.now() })}>{tr("确认这些单价用于当前模型")}</Button></div> : null}
            {modelInfo?.pricing ? <Button size="sm" onClick={() => setDraft({ ...draft, priceIn: String(modelInfo.pricing!.input ?? ''), priceOut: String(modelInfo.pricing!.output ?? ''), priceCached: '', priceWrite: '', pricingModel: draft.model.trim(), pricingUpdatedAt: modelInfo.checkedAt })}>{tr("填入官方参考输入 / 输出单价")}</Button> : null}
            <div className="grid grid-cols-2 gap-3">
              <Field label={tr("输入")} htmlFor="pv-pin">
                <Input id="pv-pin" value={draft.priceIn} onChange={(e) => set('priceIn', e.target.value)} placeholder="0.00" className="tabular" />
              </Field>
              <Field label={tr("输出")} htmlFor="pv-pout">
                <Input id="pv-pout" value={draft.priceOut} onChange={(e) => set('priceOut', e.target.value)} placeholder="0.00" className="tabular" />
              </Field>
              <Field label={tr("缓存命中")} htmlFor="pv-pc">
                <Input id="pv-pc" value={draft.priceCached} onChange={(e) => set('priceCached', e.target.value)} placeholder={tr("同输入")} className="tabular" />
              </Field>
              <Field label={tr("缓存写入")} htmlFor="pv-pw" hint={tr("Claude 官方 5 分钟缓存留空按输入价 × 1.25，其余按输入价。")}>
                <Input id="pv-pw" value={draft.priceWrite} onChange={(e) => set('priceWrite', e.target.value)} placeholder={tr("自动估算")} className="tabular" />
              </Field>
            </div>
          </Section>
        </fieldset>
      ) : null}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Cards

interface Health {
  requests: number
  errors: number
  aborted?: number
  costUsd: number
  estimatedRequests?: number
  ttftMs?: number
  last?: RequestLog
}

function HealthLine({ h }: { h: Health }) {
  useTicker()
  if (!h.last) return <div className="text-[12px] text-subtle">{tr("还没有请求经过它")}</div>
  const rate = h.requests ? Math.round(((h.requests - h.errors - (h.aborted ?? 0)) / h.requests) * 100) : undefined
  return (
    <div className="space-y-1 text-[12px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted">{tr("今日")}</span>
        <span className="min-w-0 text-right leading-relaxed tabular">
          {h.requests} {tr(" 次")}{rate !== undefined ? tr(" · 成功率 {0}%", rate) : ''}
          {h.ttftMs !== undefined ? tr(" · 首字 {0}", fmtMs(h.ttftMs)) : ''}
          {h.estimatedRequests ? tr(" · 已估算 {0}", fmtCost(h.costUsd)) : ''}
        </span>
      </div>
      {h.last.status === 'error' ? (
        <div className="truncate text-danger" title={h.last.error}>
          {tr("最近失败 · ")}{timeAgo(h.last.ts)}：{(h.last.error ?? '').replace(/^\[Accio (?:Switch|BYOK)\]\s*/, '')}
        </div>
      ) : (
        <div className="text-subtle">{tr("最近一次 ")}{timeAgo(h.last.ts)} · {h.last.status === 'ok' ? tr("成功") : tr("已取消")}</div>
      )}
    </div>
  )
}

function ProviderCard({ p, active, health, onEdit, onDelete }: { p: ProviderView; active: boolean; health: Health; onEdit: () => void; onDelete: () => void }) {
  const switchTo = useSwitchProvider()
  const [test, setTest] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const { protection, ...connection } = p
  const fingerprint = JSON.stringify(connection)
  const latestProvider = useRef(fingerprint)
  latestProvider.current = fingerprint
  const operation = useRef(0)
  useEffect(() => {
    operation.current++
    setTest(null)
    setTesting(false)
    return () => { operation.current++ }
  }, [fingerprint])
  const runTest = async () => {
    const version = ++operation.current
    const current = () => version === operation.current && fingerprint === latestProvider.current
    setTesting(true)
    setTest(null)
    try {
      const result = await api.testProvider(toInput(fromView(p)))
      if (current()) setTest(result)
    } catch (e) {
      if (current()) setTest({ ok: false, latencyMs: 0, model: p.model, message: (e as Error).message })
    } finally {
      if (current()) setTesting(false)
    }
  }
  return (
    <Card className={cn('group flex flex-col p-4 transition', active ? 'border-accent/50 ring-3 ring-accent-ring/40' : 'hover:shadow-pop')}>
      <div className="flex items-start gap-3">
        <ProviderAvatar presetId={p.presetId} name={p.name} size={42} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{p.name}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <KindBadge kind={p.kind} />
            <span className="truncate text-[11.5px] text-subtle">{hostOf(p.baseUrl)}</span>
          </div>
        </div>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={tr("{0} 的更多操作", p.name)}>
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={onEdit}>
              <Pencil />
              {tr("编辑")}</MenuItem>
            <MenuItem onSelect={() => void runTest()}>
              <Wifi />
              {tr("测试连接")}</MenuItem>
            <MenuItem
              onSelect={() =>
                void api.duplicateProvider(p.id).then((c) => c && toast.success(tr("已复制为 {0}", c.name)))
              }
            >
              <Copy />
              {tr("复制")}</MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={onDelete}>
              <Trash2 />
              {tr("删除")}</MenuItem>
          </MenuContent>
        </Menu>
      </div>

      <dl className="mt-4 space-y-1.5 text-[12.5px]">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">{tr("模型")}</dt>
          <dd className={cn('truncate font-mono', !p.model && 'text-warning')}>{p.model || tr("未设置")}</dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted">Key</dt>
          <dd className="flex items-center gap-1 truncate font-mono text-muted">
            <KeyRound className="size-3" />
            {p.hasApiKey ? p.apiKeyMasked : tr("未设置")}
          </dd>
        </div>
        {Object.keys(p.modelOverrides ?? {}).length ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">{tr("映射")}</dt>
            <dd>{Object.keys(p.modelOverrides).length} {tr(" 条")}</dd>
          </div>
        ) : null}
      </dl>

      <div className={cn('mt-4 rounded-lg px-3 py-2', health.last?.status === 'error' ? 'bg-danger-soft' : 'bg-fg/[0.035]')}>
        <HealthLine h={health} />
      </div>
      <div className="mt-3"><ConnectionStatus value={protection} /></div>

      <div className="mt-3 flex min-h-[18px] items-center text-[12px]">
        {testing ? (
          <span className="inline-flex items-center gap-1.5 text-muted">
            <Loader2 className="size-3.5 animate-spin" />
            {tr("测试中…")}</span>
        ) : test ? (
          <span className={cn('inline-flex min-w-0 items-center gap-1.5', test.ok ? 'text-success' : 'text-danger')} title={test.message}>
            {test.ok ? <Check className="size-3.5 shrink-0" /> : <X className="size-3.5 shrink-0" />}
            <span className="truncate">{test.ok ? tr("短文本通过 · 首字 {0}", fmtMs(test.latencyMs)) : test.message}</span>
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex gap-2">
        {active ? (
          <Button variant="soft" className="flex-1" disabled>
            <Check />
            {tr("已选择")}</Button>
        ) : (
          <Button className="flex-1" onClick={() => void switchTo(p.id, p.name)} disabled={!p.model} title={p.model ? undefined : tr("先设置默认模型")}>
            {tr("使用")}</Button>
        )}
        <Button onClick={onEdit} aria-label={tr("编辑")}>
          <Pencil />
        </Button>
      </div>
    </Card>
  )
}

function OfficialCard({ active, gateway, health }: { active: boolean; gateway: string; health: Health }) {
  const switchTo = useSwitchProvider()
  return (
    <Card className={cn('relative flex flex-col overflow-hidden p-4', active ? 'border-accent/50 ring-3 ring-accent-ring/40' : '')}>
      <div className="flex items-start gap-3">
        <OfficialAvatar size={42} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{tr("Accio 官方")}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <Badge tone="outline">{tr("内置")}</Badge>
            <span className="truncate text-[11.5px] text-subtle">{hostOf(gateway)}</span>
          </div>
        </div>
      </div>
      <p className="mt-4 text-[12.5px] leading-relaxed text-muted">{tr("请求原样转发到 Accio 网关，使用账号自带的模型和额度，Accio 里的模型选择照常生效。")}</p>
      <div className="mt-auto pt-4">
        <div className="mb-3 rounded-lg bg-fg/[0.035] px-3 py-2">
          <HealthLine h={health} />
        </div>
        {active ? (
          <Button variant="soft" className="w-full" disabled>
            <Check />
            {tr("已选择")}</Button>
        ) : (
          <Button className="w-full" onClick={() => void switchTo(OFFICIAL_PROVIDER_ID, tr("Accio 官方"))}>
            {tr("切回官方")}</Button>
        )}
      </div>
    </Card>
  )
}

export function ProvidersPage() {
  const { state, intent, clearIntent, logs } = useStore()
  const [editing, setEditing] = useState<ProviderView | 'new' | null>(null)
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState<ProviderView | null>(null)
  const [today, setToday] = useState<UsageStats | null>(null)
  const latest = logs[0]?.id

  useEffect(() => {
    let current = true
    const t = setTimeout(() => void api.usageStats(1).then((v) => { if (current) setToday(v) }).catch((e) => { if (current) { setToday(null); toast.error(tr("读取用量失败"), { id: 'usage-read-error', description: e.message }) } }), 200)
    return () => { current = false; clearTimeout(t) }
  }, [latest])

  useEffect(() => {
    if (intent === 'add') {
      setEditing('new')
      setOpen(true)
      clearIntent()
    } else if (intent?.startsWith('edit:') && state) {
      const target = state.providers.find((p) => p.id === intent.slice(5))
      if (target) {
        setEditing(target)
        setOpen(true)
      }
      clearIntent()
    }
  }, [intent, clearIntent, state])

  const startOfDay = new Date().setHours(0, 0, 0, 0)
  const healthOf = (id: string): Health => {
    const b = today?.byProvider.find((x) => x.key === id)
    const ttfts = logs.filter((l) => l.providerId === id && l.ts >= startOfDay && l.ttftMs).map((l) => l.ttftMs!)
    return {
      requests: b?.requests ?? 0,
      errors: b?.errors ?? 0,
      aborted: b?.aborted ?? 0,
      costUsd: b?.costUsd ?? 0,
      estimatedRequests: b?.estimatedRequests,
      ttftMs: ttfts.length ? ttfts.reduce((a, c) => a + c, 0) / ttfts.length : undefined,
      last: logs.find((l) => l.providerId === id),
    }
  }

  const providers = state?.providers ?? []
  const activeId = state?.activeProviderId ?? OFFICIAL_PROVIDER_ID
  const officialActive = activeId === OFFICIAL_PROVIDER_ID || !providers.some((p) => p.id === activeId)

  return (
    <>
      <PageHeader
        title={tr("模型接入")}
        description={tr("Accio 通过 Accio BYOK 启动后，切换会在下一条请求生效，无需重启。")}
        actions={
          <Button
            variant="primary"
            onClick={() => {
              setEditing('new')
              setOpen(true)
            }}
          >
            <Plus />
            {tr("添加供应商")}</Button>
        }
      />
      {state && providers.length > 0 ? <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3"><p className="text-[13px] text-muted">{effectState(state).label}</p><StartAccioButton /></Card> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <OfficialCard active={officialActive} gateway={state?.settings.upstreamGateway ?? ''} health={healthOf(OFFICIAL_PROVIDER_ID)} />
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            p={p}
            active={p.id === activeId}
            health={healthOf(p.id)}
            onEdit={() => {
              setEditing(p)
              setOpen(true)
            }}
            onDelete={() => setDeleting(p)}
          />
        ))}
        <button
          onClick={() => {
            setEditing('new')
            setOpen(true)
          }}
          className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-strong text-muted transition hover:border-accent hover:bg-accent-soft/40 hover:text-accent"
        >
          <Plus className="size-6" />
          <span className="text-[13px] font-medium">{tr("添加供应商")}</span>
          <span className="text-[12px] text-subtle">{tr("{0} 个预设 · 支持任意兼容接口", PRESETS.filter((p) => !p.hidden).length)}</span>
        </button>
      </div>
      <ProviderEditor open={open} onOpenChange={setOpen} initial={editing} />
      <Confirm
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={tr("删除 {0}？", deleting?.name ?? '')}
        description={deleting?.id === activeId ? tr("它是当前选中的来源，删除后会自动切回 Accio 官方。") : tr("保存的 Key 会一并删除，此操作不可撤销。")}
        confirmText={tr("删除")}
        danger
        onConfirm={async () => {
          if (deleting) await api.deleteProvider(deleting.id)
          toast(tr("已删除"))
        }}
      />
    </>
  )
}
