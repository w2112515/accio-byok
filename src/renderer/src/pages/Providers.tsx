import { getLanguage, tr, tx } from '../../../shared/i18n.ts'
import { ACCESS_REVIEWED_AT, SUBSCRIPTION_ROUTES, subscriptionRoute, fundingLabel, usageUrl } from '../../../shared/provider-access.ts'
import { checkNeedsReview, checkScopeLabel } from '../../../shared/connection-status.ts'
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
import { autoParameters, knownModelInfo, reasoningEffortIssue, usableModelInfo } from '../../../shared/model-info.ts'
import {
  OFFICIAL_PROVIDER_ID,
  REASONING_EFFORTS,
  type AccioModelInfo,
  type ProviderInput,
  type ProviderKind,
  type ProviderView,
  type RequestLog,
  type TestResult,
  type TestScope,
  type ModelInfo,
  type ThinkingMode,
  type AuthMode,
  type UsageStats,
  type ReasoningPreference,
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
  parameterMode: 'auto' | 'custom'
  reasoningPreference: ReasoningPreference
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
  authMode: AuthMode
  credentialId?: string
  subscriptionAcknowledged: boolean
  fallbackEligible: boolean
}

const num = (s: string) => {
  if (!s.trim()) return undefined
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) throw new Error(tr("Token 与价格必须填写有效的非负数字"))
  return n
}

function urlErrorFor(draft: Draft): string | undefined {
  try { normalizeBaseUrl(draft.kind, draft.baseUrl) } catch (e) { return (e as Error).message }
  return undefined
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
    parameterMode: 'auto', reasoningPreference: 'auto',
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
    authMode: d.authMode ?? (p.category === 'local' ? 'none' : 'api-key'), subscriptionAcknowledged: false, fallbackEligible: false,
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
    parameterMode: v.parameterMode ?? 'custom', reasoningPreference: v.reasoningPreference ?? 'auto',
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
    authMode: v.authMode ?? 'api-key', credentialId: v.credentialId, subscriptionAcknowledged: v.subscriptionAcknowledged ?? false, fallbackEligible: v.fallbackEligible ?? false,
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
    parameterMode: d.parameterMode, reasoningPreference: d.reasoningPreference,
    authMode: d.authMode, credentialId: d.credentialId, subscriptionAcknowledged: d.subscriptionAcknowledged, fallbackEligible: d.fallbackEligible,
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

function channelPresets(): ProviderPreset[] {
  return PRESETS.flatMap((p) => {
    if (p.hidden || ['relay', 'local', 'custom'].includes(p.category)) return [p]
    const channels = [{ ...p, name: `${p.name} · API` }]
    for (const route of SUBSCRIPTION_ROUTES[p.id] ?? []) channels.push({ ...p, name: route.name, baseUrl: route.baseUrl, keyUrl: route.usageUrl, docsUrl: route.docsUrl, description: tx('Subscription key · dedicated plan endpoint', '订阅专用 Key · 套餐服务地址'), modelHints: route.model ? [route.model] : [], defaults: { ...p.defaults, authMode: 'subscription-key', openaiApi: 'chat', model: route.model, pricing: undefined } })
    if (p.id === 'openai' || p.id === 'openrouter') channels.push({ ...p, name: p.id === 'openai' ? 'ChatGPT · OAuth' : 'OpenRouter · OAuth', description: p.id === 'openai' ? tx('Sign in with ChatGPT · use an eligible plan', '使用 ChatGPT 登录 · 符合条件的套餐') : tx('Sign in with OpenRouter · API billing', '使用 OpenRouter 登录 · API 计费'), defaults: { ...p.defaults, authMode: p.id === 'openai' ? 'openai-oauth' : 'openrouter-oauth' } })
    return channels
  })
}

function PresetGallery({ onPick }: { onPick: (p: ProviderPreset) => void }) {
  const [q, setQ] = useState('')
  const language = getLanguage()
  const groups = useMemo(() => {
    const k = q.trim().toLowerCase()
    const list = channelPresets().filter((p) => !p.hidden && (!k || `${p.name} ${p.description} ${p.baseUrl}`.toLowerCase().includes(k)))
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
                  key={`${p.id}:${p.baseUrl}:${p.defaults.authMode ?? 'api-key'}`}
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
  const connection = JSON.stringify([draft.id, draft.kind, draft.openaiApi, draft.baseUrl, draft.apiKey, draft.keyTouched, draft.headersText, draft.allowInsecureHttp, draft.authMode, draft.credentialId, draft.subscriptionAcknowledged])
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

function ReasoningSettings({ value, info, issue, onChange }: { value: ReasoningPreference; info?: ModelInfo; issue?: string; onChange: (v: ReasoningPreference) => void }) {
  const levels = REASONING_EFFORTS.filter((v) => info?.effortLevels?.includes(v))
  const legacy = value === 'fast' || value === 'deep'
  const legacyLevels = levels.filter((v) => v !== 'none')
  const legacyValue = value === 'fast' ? legacyLevels[0] : legacyLevels.at(-1)
  const labels = {
    none: tx('Off', '关闭'), minimal: tx('Minimal', '最少'), low: tx('Low', '低'), medium: tx('Medium', '中'),
    high: tx('High', '高'), xhigh: tx('Extra high', '很高'), max: tx('Maximum', '最大'), ultra: 'Ultra',
  }
  const options: { value: ReasoningPreference; label: string }[] = [
    { value: 'auto', label: tx('Model default', '模型默认') },
    ...levels.map((level) => ({ value: level, label: `${labels[level]} · ${level}` })),
  ]
  if (legacy) options.push({ value, label: `${value === 'fast' ? tx('Faster (legacy)', '更快（旧设置）') : tx('Deeper (legacy)', '更深入（旧设置）')} · ${legacyValue ?? tx('Model default', '模型默认')}` })
  else if (value !== 'auto' && !levels.includes(value)) options.push({ value, label: `${value} · ${tx('Unavailable for this model', '当前模型不可用')}` })
  return <Field label={tx('Reasoning effort', '思考程度')} htmlFor="pv-effort">
    <SelectBox id="pv-effort" label={tx('Reasoning effort', '思考程度')} value={value} onChange={onChange} options={options} />
    {issue ? <p role="alert" className="mt-2 text-[12px] leading-relaxed text-danger">{issue}</p> : null}
    {!issue ? <p className="mt-2 text-[12px] leading-relaxed text-muted">{legacy
      ? tx('Your previous preference is preserved: it follows the target model’s lowest/highest supported level. Choose a specific level to send that exact value.', '保留原有偏好：随目标模型使用其最低／最高档位。选择具体档位后，将按该值发送。')
      : value === 'auto'
        ? tx('No effort value is sent; the service chooses its default.', '不指定 effort，由服务端采用默认值。')
        : tx(`Requests use effort ${value}. Mapped models must support the same value.`, `请求使用 effort=${value}；单独映射的模型也需要支持该档位。`)}</p> : null}
    {!levels.length ? <p className="mt-1 text-[12px] text-subtle">{tx('This connection has not provided confirmed adjustable levels for this model.', '当前连接尚未提供该模型已确认的可调档位。')}</p> : null}
    <p className="mt-1 text-[11px] text-subtle">{tx('Deeper reasoning can increase tokens and latency. Changing effort may affect prompt caching.', '更深入可能增加 Token 消耗和等待时间；切换档位可能影响缓存命中。')}</p>
  </Field>
}

function ProviderEditor({ open, onOpenChange, initial, focusChecks = false }: { open: boolean; onOpenChange: (v: boolean) => void; initial: ProviderView | 'new' | null; focusChecks?: boolean }) {
  const { state, logs } = useStore()
  const [step, setStep] = useState<'preset' | 'form' | 'ready'>('preset')
  const [ready, setReady] = useState<{ provider: ProviderView; at: number } | null>(null)
  const [formError, setFormError] = useState<string>()
  const [readingInfo, setReadingInfo] = useState(false)
  const [infoMessage, setInfoMessage] = useState<string>()
  const infoOperation = useRef(0)
  const metadataAttempt = useRef('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [welcome, setWelcome] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)
  const [accioModels, setAccioModels] = useState<AccioModelInfo[]>([])
  const switchTo = useSwitchProvider()
  const latestDraft = useRef(draft)
  latestDraft.current = draft
  const operation = useRef(0)
  const checksSection = useRef<HTMLDivElement>(null)
  const savedChecks = initial && initial !== 'new' ? state?.providers.find((p) => p.id === initial.id)?.checks : undefined

  useEffect(() => {
    operation.current++
    infoOperation.current++
    metadataAttempt.current = ''
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
  useEffect(() => {
    if (!open || step !== 'form' || !focusChecks) return
    const frame = requestAnimationFrame(() => {
      checksSection.current?.scrollIntoView({ block: 'center' })
      checksSection.current?.querySelector('button')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, step, focusChecks])

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
  const isOAuth = !!draft?.authMode.endsWith('-oauth')
  const lockedEndpoint = isOAuth || draft?.authMode === 'subscription-key'
  const registration = state?.authorizations?.find((a) => a.id === draft?.credentialId)
  const subscription = draft ? subscriptionRoute(draft) : undefined
  const keyUrl = draft?.authMode === 'subscription-key' ? subscription?.usageUrl : preset?.keyUrl
  const changeAuth = (mode: AuthMode) => {
    if (!draft || !preset) return
    const route = SUBSCRIPTION_ROUTES[preset.id]?.[0]
    setDraft({ ...draft, authMode: mode, credentialId: undefined, kind: mode === 'api-key' ? preset.kind : 'openai', openaiApi: mode === 'openai-oauth' ? 'responses' : mode === 'subscription-key' || mode === 'openrouter-oauth' ? 'chat' : preset.defaults.openaiApi ?? 'chat', baseUrl: mode === 'subscription-key' ? route!.baseUrl : preset.baseUrl, model: mode === 'subscription-key' ? route?.model ?? '' : '', apiKey: '', hasKey: false, keyTouched: true, headersText: '', subscriptionAcknowledged: false, modelInfo: undefined, priceIn: '', priceOut: '', priceCached: '', priceWrite: '' })
  }
  const signIn = async (newAccount = false) => {
    if (!draft || !isOAuth) return
    const currentDraft = draft
    setSigningIn(true); setFormError(undefined)
    try {
      const result = await api.signIn(draft.authMode === 'openai-oauth' ? 'openai' : 'openrouter', newAccount ? undefined : draft.credentialId)
      if (latestDraft.current !== currentDraft) return
      setDraft({ ...draft, credentialId: result.id })
      if (result.service === 'openai' && result.firstSignIn && result.planEnabled) setWelcome(true)
      if (!result.planEnabled) setInfoMessage(tx('Signed in. ChatGPT plan permission is disabled; continue with ChatGPT to enable it.', '已登录，但未授权使用 ChatGPT 套餐；请继续登录并启用权限。'))
    } catch (e) { setFormError((e as Error).message) }
    finally { setSigningIn(false) }
  }
  const modelInfo = draft ? usableModelInfo(draft, draft.model.trim()) : undefined
  const effortIssue = draft ? [...new Set([draft.model.trim(), ...draft.overrides.filter((o) => o.from.trim() && o.to.trim()).map((o) => o.to.trim())])]
    .map((model) => reasoningEffortIssue(draft, model)).find(Boolean) : undefined
  const recommended = draft && !urlErrorFor(draft) ? autoParameters({ kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model.trim(), modelInfo: draft.modelInfo, authMode: draft.authMode, parameterMode: 'auto' }) : undefined
  const useParameterMode = (mode: 'auto' | 'custom') => {
    if (!draft) return
    if (mode === 'custom' && draft.parameterMode === 'auto' && recommended) setDraft({ ...draft, parameterMode: mode, sendReasoningEffort: recommended.sendReasoningEffort ?? false, sendReasoningContent: recommended.sendReasoningContent ?? false, thinking: recommended.thinking ?? 'off', thinkingBudget: String(recommended.thinkingBudget ?? 8000), promptCaching: recommended.promptCaching ?? false, sendSampling: recommended.sendSampling ?? false, openaiApi: recommended.openaiApi ?? draft.openaiApi, maxOutputTokens: '' })
    else set('parameterMode', mode)
  }
  const readInfo = async () => {
    if (!draft || testing || saving || signingIn) return
    metadataAttempt.current = metadataIdentity
    const currentDraft = draft
    const version = ++infoOperation.current
    setReadingInfo(true)
    setInfoMessage(undefined)
    try {
      const info = await api.providerModelInfo(toInput(draft))
      if (version !== infoOperation.current || latestDraft.current !== currentDraft) return
      if (info) { setDraft({ ...draft, modelInfo: info }); setInfoMessage(tr("已读取接口提供的信息；这不代表能力已经实测。")) }
      else setInfoMessage(knownModelInfo(draft.kind, draft.baseUrl, draft.model.trim()) ? tx('No additional API metadata; using verified official references.', '接口未提供补充信息，已采用核对过的官方资料。') : tr("该接口未提供可用的模型元数据，可依据供应商文档手动填写。"))
    } catch (e) {
      if (version === infoOperation.current && latestDraft.current === currentDraft) setInfoMessage(tr("读取失败：{0}。已填写的信息保留。", (e as Error).message))
    } finally { if (version === infoOperation.current) setReadingInfo(false) }
  }
  const setWindow = (value: string) => {
    if (!draft) return
    setDraft({ ...draft, modelInfo: { ...modelInfo, model: draft.model.trim(), contextWindow: value ? Number(value) : undefined, windowKind: 'context', source: 'user', sourceUrl: undefined, checkedAt: Date.now() } })
  }
  const metadataIdentity = draft ? JSON.stringify([draft.id, draft.kind, draft.baseUrl, draft.apiKey, draft.keyTouched, draft.credentialId, draft.headersText, draft.authMode, draft.subscriptionAcknowledged, draft.model.trim(), draft.parameterMode]) : ''
  useEffect(() => {
    infoOperation.current++
    setReadingInfo(false)
    setInfoMessage(undefined)
  }, [metadataIdentity])
  useEffect(() => {
    if (testing || saving || signingIn || metadataAttempt.current === metadataIdentity) return
    if (!open || step !== 'form' || !draft || draft.parameterMode !== 'auto' || !draft.model.trim() || (draft.modelInfo?.model === draft.model.trim() && draft.modelInfo.source === 'user') || urlErrorFor(draft)) return
    if (draft.modelInfo?.model === draft.model.trim() && draft.modelInfo.source === 'api' && Date.now() - draft.modelInfo.checkedAt < 5 * 60_000) return
    if (draft.authMode === 'subscription-key' && !draft.subscriptionAcknowledged) return
    if (draft.authMode.endsWith('-oauth') ? !draft.credentialId : draft.authMode !== 'none' && !(draft.apiKey || (!draft.keyTouched && draft.hasKey))) return
    const timer = setTimeout(() => void readInfo(), 800)
    return () => clearTimeout(timer)
  }, [metadataIdentity, open, step, testing, saving, signingIn])
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
    if (!draft || readingInfo || urlError || effortIssue || !draft.model.trim()) return
    metadataAttempt.current = metadataIdentity
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
    if (!draft || readingInfo || effortIssue) return
    metadataAttempt.current = metadataIdentity
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
    <><Modal
      open={open}
      onOpenChange={(v) => { if (!saving) { if (!v && signingIn) void api.cancelSignIn(); onOpenChange(v) } }}
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
            {isNew ? tr("添加 {0}", preset?.category === 'custom' ? tr("自定义供应商") : (draft?.name ?? preset?.name ?? '')) : tr("编辑 {0}", draft?.name ?? '')}
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
              {testing ? tr("正在测试提交时的配置…修改配置后，本次结果不再适用。") : <>{test?.scope ? `${{ text: tr("短文本"), tools: tr("工具调用"), image: tr("图片识别"), multiturn: tx('Tool round trip', '工具多轮续接') }[test.scope]} · ` : ''}{test?.checkedAt ? `${fmtDateTime(test.checkedAt)} · ` : ''}{test?.ok ? tr("通过 · {0} · {1}", fmtMs(test.latencyMs), test.message) : test?.message}</>}
            </div> : null}
            <div className="flex justify-end gap-2">
            <Button onClick={() => void runTest()} disabled={readingInfo || signingIn || saving || testing || !!urlError || !!effortIssue || !draft.model.trim()}>
              <Wifi />
              {tr("测试")}</Button>
            <Button onClick={save} disabled={readingInfo || signingIn || saving || testing || !!urlError || !!effortIssue || !draft.model.trim()}>
              {tr("仅保存")}</Button>
            <Button variant="primary" onClick={() => void runTest(true)} loading={saving || testing} disabled={readingInfo || signingIn || !!urlError || !!effortIssue || !draft.model.trim()}>
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
          <Field label={tx('Access channel', '接入渠道')}>
            <SelectBox label={tx('Access channel', '接入渠道')} value={draft.authMode} disabled={signingIn} onChange={(v) => changeAuth(v as AuthMode)} options={[
              { value: 'api-key', label: `${preset?.name ?? 'API'} · API Key` },
              ...(preset?.id === 'openai' ? [{ value: 'openai-oauth', label: 'ChatGPT · OAuth' }] : []),
              ...(preset?.id === 'openrouter' ? [{ value: 'openrouter-oauth', label: 'OpenRouter · OAuth' }] : []),
              ...(SUBSCRIPTION_ROUTES[preset?.id ?? ''] ? [{ value: 'subscription-key', label: `${subscription?.name ?? SUBSCRIPTION_ROUTES[preset!.id][0].name} · ${tx('Subscription', '订阅')}` }] : []),
              ...(preset?.category === 'local' ? [{ value: 'none', label: tx('No key · Local model', '无 Key · 本地模型') }] : []),
            ]} />
          </Field>
          {isOAuth ? <div className="space-y-3 rounded-xl border border-border p-4">
            <p className="text-[13px] font-medium">{draft.authMode === 'openai-oauth' && (!registration?.connected || !registration.planEnabled) ? tx('Connect your ChatGPT plan', '连接 ChatGPT 套餐') : fundingLabel(draft)}</p>
            <p className="text-[12px] leading-relaxed text-muted">{draft.authMode === 'openai-oauth' ? tx('Uses your eligible ChatGPT plan and any credits you enable in ChatGPT settings. Access depends on your account and workspace. Your API key remains a separate connection.', '使用符合条件的 ChatGPT 套餐及你在 ChatGPT 设置中启用的积分；是否可用取决于账号和工作区。API Key 连接单独保存。') : tx('OpenRouter creates an API key for this app in your browser. Requests use your OpenRouter billing, not another provider’s subscription.', 'OpenRouter 在浏览器中为此应用创建 API Key，使用 OpenRouter 的计费方式，不会转接其他厂商的订阅。')}</p>
            {(state?.authorizations ?? []).some((a) => a.service === (draft.authMode === 'openai-oauth' ? 'openai' : 'openrouter')) ? <SelectBox label={tx('Saved account', '已保存账号')} value={draft.credentialId} disabled={signingIn} onChange={(v) => set('credentialId', v)} placeholder={tx('Select an account', '选择账号')} options={(state?.authorizations ?? []).filter((a) => a.service === (draft.authMode === 'openai-oauth' ? 'openai' : 'openrouter')).map((a) => ({ value: a.id, label: `${a.label} · ${a.connected ? tx('Connected', '已连接') : tx('Signed out', '已退出')}` }))} /> : null}
            {registration ? <p role="status" className="text-[12px] text-muted">{registration.connected ? tx('Signed in', '已登录') : tx('Sign-in required', '需要重新登录')} · {registration.label}</p> : null}
            {registration?.pauseReason ? <p role="alert" className="text-[12px] text-warning">{registration.pauseReason}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="primary" loading={signingIn} onClick={() => void signIn()}>{draft.authMode === 'openai-oauth' ? 'Continue with ChatGPT' : tx('Connect OpenRouter', '连接 OpenRouter')}</Button>
              {signingIn ? <Button type="button" onClick={() => void api.cancelSignIn()}>{tr('取消')}</Button> : draft.credentialId ? <Button type="button" onClick={() => void signIn(true)}>{tx('Add another account', '添加另一个账号')}</Button> : null}
              <Button type="button" onClick={() => void api.openExternal(draft.authMode === 'openai-oauth' ? 'https://chatgpt.com/settings/usage' : 'https://openrouter.ai/keys')}>{tx('Manage usage', '管理用量')}</Button>
              {registration?.pauseReason ? <Button type="button" disabled={signingIn} onClick={() => void api.resumeAuthorization(registration.id).catch((e) => toast.error(e.message))}>{tx('Resume after checking usage', '已核对用量，恢复请求')}</Button> : null}
            </div>
            {signingIn ? <p role="status" className="text-[12px] text-muted">{tx('Complete sign-in in your browser, then return here. Waiting up to 5 minutes.', '请在浏览器完成登录后返回，最多等待 5 分钟。')}</p> : null}
          </div> : null}
          {draft.authMode === 'subscription-key' ? <div className="space-y-3 rounded-xl border border-warning/30 p-4">
            <SelectBox label={tx('Subscription endpoint', '订阅服务端点')} value={draft.baseUrl} onChange={(v) => setDraft({ ...draft, baseUrl: v, model: SUBSCRIPTION_ROUTES[draft.presetId!].find((r) => r.baseUrl === v)?.model ?? '', subscriptionAcknowledged: false, modelInfo: undefined })} options={SUBSCRIPTION_ROUTES[draft.presetId!]!.map((r) => ({ value: r.baseUrl, label: r.name }))} />
            <p className="text-[12px] leading-relaxed text-muted">{tx('Use only for the personal interactive coding / agent tasks permitted by this plan. General Accio research and unattended automation may be excluded. The provider may charge extra usage if you enabled it; remaining quota and extra charges are not inferred locally.', '仅用于套餐允许的个人交互式编程或 Agent 任务。普通 Accio 调研及无人值守自动化可能不在允许范围；供应商可按已开启的设置扣除额外用量，本地不推算剩余额度或额外费用。')}</p>
            <Button type="button" size="sm" onClick={() => subscription && void api.openExternal(subscription.docsUrl)}>{tx('Read plan rules', '查看套餐规则')}</Button>
            <ToggleRow label={tx('My intended use is permitted by this plan', '我的使用场景符合此套餐规则')} checked={draft.subscriptionAcknowledged} onChange={(v) => set('subscriptionAcknowledged', v)} />
            <p className="text-[11px] text-subtle">{tx('Access documentation reviewed', '接入文档核对日期')} · {ACCESS_REVIEWED_AT}</p>
          </div> : null}
            <Field label={tr("名称")} htmlFor="pv-name">
              <Input id="pv-name" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder={preset?.name ?? tr("给它起个名字")} />
            </Field>
          <Section title={tx('Connection details', '连接详情')} description={`${draft.kind === 'openai' ? (draft.parameterMode === 'auto' ? recommended?.openaiApi ?? draft.openaiApi : draft.openaiApi) === 'responses' ? 'Responses' : 'Chat Completions' : KIND_LABEL[draft.kind]} · ${draft.baseUrl || tx('Enter endpoint', '填写接口地址')}`} defaultOpen={preset?.category === 'relay' || preset?.category === 'custom'}>
          <fieldset disabled={lockedEndpoint || signingIn} className="min-w-0 space-y-5">
          <div>
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
          {draft.kind === 'openai' ? <Field label={tr("OpenAI 接口协议")} hint={lockedEndpoint ? tx('This connection uses the provider’s official protocol and destination.', '此连接使用供应商的官方协议与地址。') : tr("Codex 类分组通常使用 Responses；以网关提供的接入说明为准。")}>
            <fieldset disabled={draft.parameterMode === 'auto' && !!modelInfo?.recommendedApi}><Segmented label={tr("OpenAI 接口协议")} value={draft.parameterMode === 'auto' ? recommended?.openaiApi ?? draft.openaiApi : draft.openaiApi} onChange={(v) => set('openaiApi', v)} options={[{ value: 'chat', label: 'Chat Completions' }, { value: 'responses', label: 'Responses' }]} /></fieldset>
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
          </fieldset>
          </Section>
          {!isOAuth && draft.authMode !== 'none' ? <Field
            label={
              <span className="flex items-center justify-between">
                {draft.authMode === 'subscription-key' ? tx('Subscription key', '订阅专用 Key') : 'API Key'}
                {keyUrl ? (
                  <button type="button" onClick={() => void api.openExternal(keyUrl)} className="inline-flex items-center gap-1 text-[12px] font-normal text-accent hover:underline">
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
          </Field> : null}
          <Field label={tr("默认模型")} htmlFor="pv-model" hint={tr("Accio 里选择的任何模型都会被替换成它，除非在下方单独映射。")}>
            <ModelPicker id="pv-model" draft={draft} value={draft.model} onChange={(v) => set('model', v)} />
          </Field>
          <div className="space-y-3 rounded-xl border border-accent/25 bg-accent-soft/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[13px] font-medium">{tx('Model settings', '模型设置')}</p><Segmented label={tx('Parameter mode', '参数模式')} value={draft.parameterMode} onChange={useParameterMode} options={[{ value: 'auto', label: tx('Automatic · recommended', '自动 · 推荐') }, { value: 'custom', label: tx('Custom', '自定义') }]} /></div>
            {draft.parameterMode === 'auto' ? <>
              <p className="text-[12px] leading-relaxed text-muted">{tx('Output follows Accio and is capped at the known model limit. Optional parameters follow the selected model. API metadata is read automatically after selection; no generation request is sent.', '输出沿用 Accio，并限制在已知模型上限内；可选参数随实际模型调整。选定模型后自动读取接口资料，不发送生成请求。')}</p>
              <ReasoningSettings value={draft.reasoningPreference} info={modelInfo} issue={effortIssue} onChange={(v) => set('reasoningPreference', v)} />
              {!modelInfo?.contextWindow ? <p className="text-[12px] text-warning">{tx('Window unknown. This endpoint has not supplied a verified limit; set it from provider documentation if needed.', '窗口未知：当前端点尚未提供可核实上限，可依据供应商文档补填。')}</p> : null}
            </> : <p className="text-[12px] leading-relaxed text-muted">{tx('Your existing settings are preserved. Reasoning follows the forwarding option in Advanced; the Automatic effort selection is inactive. Choose Automatic to select a model-specific effort.', '保留现有设置；推理由高级设置的转发开关控制，自动模式的档位选择在此不生效。切换到“自动”可选择当前模型的具体档位。')}</p>}
            {readingInfo ? <p role="status" className="flex items-center gap-1 text-[12px] text-muted"><Loader2 className="size-3 animate-spin" />{tx('Reading model information…', '正在读取模型信息…')}</p> : infoMessage ? <p role="status" className="text-[12px] text-muted">{infoMessage}</p> : null}
          </div>
          <div className="rounded-lg border border-border bg-fg/[0.025] px-3 py-2.5 text-[12px] leading-relaxed text-muted">
            <p>{modelInfo?.windowKind === 'input' ? tr("输入上限") : tr("上下文窗口")}：{modelInfo?.contextWindow ? `${fmtTokens(modelInfo.contextWindow)} Token` : tr("未知")} {tr(" · 最大输出：")}{modelInfo?.maxOutputTokens ? `${fmtTokens(modelInfo.maxOutputTokens)} Token` : tr("未知")}</p>
            <p>{tr("工具：")}{modelInfo?.tools === undefined ? tr("未确认") : modelInfo.tools ? tr("资料支持") : tr("资料不支持")} {tr(" · 图像：")}{modelInfo?.vision === undefined ? tr("未确认") : modelInfo.vision ? tr("资料支持") : tr("资料不支持")}</p>
            {modelInfo ? <p className="mt-1 text-subtle">{tr("来源：")}{{ official: tr("官方资料"), api: tr("供应商接口"), user: tr("手动填写") }[modelInfo.source]} · {fmtDateTime(modelInfo.checkedAt)}{modelInfo.sourceUrl ? <button type="button" className="ml-2 text-accent hover:underline" onClick={() => void api.openExternal(modelInfo.sourceUrl!)}>{tr("查看来源")}</button> : null}</p> : <p className="mt-1 text-subtle">{tr("短文本通过不代表工具和图像可用；可展开下方模型信息核对。")}</p>}
          </div>
          <p className="text-[12px] leading-relaxed text-subtle">{tx('Long conversations: Accio controls automatic compaction. These limits inform warnings and output settings; they do not change Accio’s compaction threshold. Before switching to a smaller window, compact in Accio or start a new conversation.', '长会话保护：自动压缩由 Accio 控制。这里的窗口用于提示和输出设置，不会修改 Accio 的压缩阈值；换到较小窗口前，请先在 Accio 整理或新建会话。')}</p>
          <p className="text-[12px] leading-relaxed text-subtle">{tx('Checks send synthetic prompts and may consume paid usage or subscription quota. Tool round trips send up to two requests. Checks are excluded from Accio usage totals. ChatGPT plan requests cannot set an output-token limit.', '检测会发送合成提示词，可能消耗费用或套餐额度。工具多轮检测最多发送两次请求，检测用量不计入 Accio 汇总。ChatGPT 套餐请求不支持设置输出 Token 上限。')}</p>
          {initial && initial !== 'new' && initial.keyError && !draft.keyTouched ? <p role="alert" className="text-[12.5px] text-danger">{initial.keyError}</p> : null}
          <div ref={checksSection}><Section title={tr("可选能力检测")} description={tr("需要工具或图片功能时分别检查；不会自动调用")} defaultOpen={focusChecks}>
            <p className="text-[12px] leading-relaxed text-subtle">{tx('Tool checks return fixed arguments without executing real tools. Image checks use a built-in red square. Results apply to the tested configuration.', '工具检测仅返回固定参数，不执行真实工具；图片检测使用内置红色方块，结果只适用于被检测的配置。')}</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" disabled={readingInfo || signingIn || saving || testing || !!urlError || !!effortIssue || !draft.model.trim()} onClick={() => void runTest(false, 'tools')}>{tr("检测工具调用")}</Button><Button size="sm" disabled={readingInfo || signingIn || saving || testing || !!urlError || !!effortIssue || !draft.model.trim()} onClick={() => void runTest(false, 'image')}>{tr("检测图片识别")}</Button><Button size="sm" disabled={readingInfo || signingIn || saving || testing || !!urlError || !!effortIssue || !draft.model.trim()} onClick={() => void runTest(false, 'multiturn')}>{tx('Check tool round trip', '检测工具多轮续接')}</Button></div>
            {savedChecks?.length ? <div className="space-y-1 text-[12px] text-muted"><p>{tx('Saved connection evidence; edits require new checks. Checks older than 30 days are flagged for review, without automatic requests.', '已保存连接的验证记录；更改配置后需要重新检测。超过 30 天会提示复核，不自动发送请求。')}</p>{savedChecks.map((c) => <p key={c.scope} className={c.ok && checkNeedsReview(c) ? 'text-warning' : undefined}>{checkScopeLabel(c.scope)} · {c.ok ? checkNeedsReview(c) ? tx('Previously passed · review recommended', '曾通过 · 建议复核') : tx('Passed', '通过') : tx('Failed', '失败')} · {fmtDateTime(c.checkedAt)}</p>)}</div> : null}
          </Section></div>

          <ToggleRow label={tx('Offer as a fallback', '加入备用连接列表')} hint={tx('Available for manual switching after a failure. No automatic retry or paid fallback.', '失败后可手动切换到此连接；不会自动重试或转入付费通道。')} checked={draft.fallbackEligible} onChange={(v) => set('fallbackEligible', v)} />

          <Section title={tr("模型信息与窗口")} description={tr("读取供应商元数据，或依据文档填写；只适用于当前默认模型")}>
            <div className="flex flex-wrap items-center gap-3"><Button type="button" size="sm" loading={readingInfo} disabled={testing || saving || signingIn || !draft.model.trim() || !!urlError} onClick={() => void readInfo()}>{tr("读取模型信息")}</Button><span className="text-[12px] text-subtle">{tr("读取元数据，不发送生成请求；缓存 5 分钟。")}</span></div>
            {infoMessage ? <p role="status" className="text-[12px] leading-relaxed text-muted">{infoMessage}</p> : null}
            <Field label={tr("上下文窗口 Token")} htmlFor="pv-context" hint={tr("手动填写会标记为用户提供。未知可留空；它不会改变 Accio 的自动压缩阈值。")}>
              <Input id="pv-context" value={modelInfo?.contextWindow ?? ''} onChange={(e) => setWindow(e.target.value.replace(/[^\d]/g, ''))} placeholder={tr("未知")} className="w-48 tabular" />
            </Field>
            {draft.parameterMode === 'custom' && modelInfo?.maxOutputTokens ? <Button size="sm" onClick={() => set('maxOutputTokens', String(Math.min(Number(draft.maxOutputTokens) || 16384, modelInfo.maxOutputTokens!)))}>{tr("按已知输出上限调整")}</Button> : null}
            {draft.parameterMode === 'custom' && modelInfo?.thinking && draft.kind === 'anthropic' ? <Button size="sm" onClick={() => set('thinking', modelInfo.thinking!)}>{tr("采用资料建议的思考模式")}</Button> : null}
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
            {draft.parameterMode === 'auto' ? <div className="space-y-2 text-[12px] text-muted"><p>{tx('Output, reasoning, history and sampling are managed automatically for each target model. Switch to Custom to override them.', '输出、推理、思考历史与采样随目标模型自动管理。切换自定义后可手动覆盖。')}</p><Button size="sm" onClick={() => useParameterMode('custom')}>{tx('Customize recommended settings', '以推荐配置为基础自定义')}</Button></div> : null}
            <p className="text-[12px] leading-relaxed text-muted">{tr("连接保护：相同地址与凭据最多 4 个并发请求；HTTP 429 后按 Retry-After 等待（缺失时 60 秒）。不会自动重试、切换账户或跟随接口重定向。这些措施不能保证账号不受限。")}</p>
            {/^http:\/\//i.test(draft.baseUrl) ? <ToggleRow label={tr("允许远程 HTTP")} hint={tr("仅在你了解风险时开启：本机以外的 HTTP 会明文传输 Key 和会话。优先使用 HTTPS。本机服务不需要开启。")} checked={draft.allowInsecureHttp} onChange={(v) => set('allowInsecureHttp', v)} /> : null}
            <p className="text-[12px] leading-relaxed text-subtle">{tr("自动压缩由 Accio 管理，依据它所选模型的上下文窗口。BYOK 热切换不会同步该阈值；目标模型窗口较小时，建议先压缩或新建会话。提示缓存节省重复输入成本，不会扩大上下文窗口。")}</p>
            {draft.parameterMode === 'custom' ? <>
            <Field label={tr("最大输出 Token")} htmlFor="pv-max" hint={draft.authMode === 'openai-oauth' ? tx('Not supported by ChatGPT plan requests; this value is omitted.', 'ChatGPT 套餐请求不支持此参数，不会发送。') : tr("留空则沿用 Accio 的请求值（通常 16384）。部分模型上限较低，如 8192。")}>
              <Input id="pv-max" disabled={draft.authMode === 'openai-oauth'} value={draft.maxOutputTokens} onChange={(e) => set('maxOutputTokens', e.target.value.replace(/[^\d]/g, ''))} placeholder={tr("沿用 Accio")} className="w-48 tabular" />
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
            {draft.authMode !== 'openai-oauth' ? <ToggleRow label={tr("转发采样参数")} hint={tr("转发 temperature / top_p。较新的 Claude 和推理模型会拒绝这些参数。")} checked={draft.sendSampling} onChange={(v) => set('sendSampling', v)} /> : null}
            </> : null}
            <Field label={tr("自定义请求头")} htmlFor="pv-headers" hint={tr("每行一个，格式为「名称: 值」。保存时随 Key 加密；此编辑区会显示原值。禁止 Cookie 和传输控制头。")}>
              <Textarea id="pv-headers" disabled={lockedEndpoint} value={draft.headersText} onChange={(e) => set('headersText', e.target.value)} placeholder="X-Custom-Header: value" className="font-mono text-[12.5px]" rows={3} spellCheck={false} />
            </Field>
          </Section>

          {draft.authMode === 'openai-oauth' || draft.authMode === 'subscription-key' ? <p className="text-[12px] leading-relaxed text-muted">{tx('Subscription usage is recorded separately. API token prices do not describe subscription quota or extra-usage charges.', '订阅用量单独记录；API Token 单价不能代表套餐额度或额外用量费用。')}</p> : <Section title={tr("价格")} description={tr("填写后用量页会估算花费（美元 / 百万 Token）")}>
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
          </Section>}
        </fieldset>
      ) : null}
    </Modal>
    <Modal open={welcome} onOpenChange={setWelcome} title={tx("You're using your ChatGPT plan", '你正在使用 ChatGPT 套餐')} footer={<Button variant="primary" onClick={() => setWelcome(false)}>{tx('Got it', '知道了')}</Button>}>
      <p className="text-[13px] leading-relaxed text-muted">{tx('Eligible requests use your ChatGPT plan or enabled credits. Review app limits and extra usage in ChatGPT settings.', '符合条件的请求会使用 ChatGPT 套餐或已启用的积分；可在 ChatGPT 设置中管理应用限额及额外用量。')}</p><Button className="mt-3" onClick={() => void api.openExternal('https://chatgpt.com/settings/usage')}>{tx('Manage usage', '管理用量')}</Button>
    </Modal></>
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
            {p.authorization ? `${p.authorization.connected ? tx('Signed in', '已登录') : tx('Signed out', '已退出')} · ${p.authorization.label}` : p.authMode === 'none' ? tx('Not required', '无需 Key') : p.hasApiKey ? p.apiKeyMasked : tr("未设置")}
          </dd>
        </div>
        {Object.keys(p.modelOverrides ?? {}).length ? (
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted">{tr("映射")}</dt>
            <dd>{Object.keys(p.modelOverrides).length} {tr(" 条")}</dd>
          </div>
        ) : null}
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-muted"><span>{fundingLabel(p)}</span>{p.fallbackEligible ? <Badge>{tx('Fallback', '备用')}</Badge> : null}{p.checks?.some((c) => c.ok && checkNeedsReview(c)) ? <Badge tone="warning">{tx('Checks need review', '检测待复核')}</Badge> : null}{usageUrl(p) ? <button className="text-accent hover:underline" onClick={() => void api.openExternal(usageUrl(p)!)}>{tx('Manage usage', '管理用量')}</button> : null}</div>

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
  const [reviewChecks, setReviewChecks] = useState(false)
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
      setReviewChecks(false)
      setEditing('new')
      setOpen(true)
      clearIntent()
    } else if ((intent?.startsWith('edit:') || intent?.startsWith('checks:')) && state) {
      const review = intent.startsWith('checks:')
      const target = state.providers.find((p) => p.id === intent.slice(review ? 7 : 5))
      if (target) {
        setReviewChecks(review)
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
          <span className="text-[12px] text-subtle">{tr("{0} 个预设 · 支持任意兼容接口", channelPresets().filter((p) => !p.hidden).length)}</span>
        </button>
      </div>
      <ProviderEditor open={open} onOpenChange={(value) => { setOpen(value); if (!value) setReviewChecks(false) }} initial={editing} focusChecks={reviewChecks} />
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
