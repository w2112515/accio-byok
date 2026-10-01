import { tr, tx } from '../shared/i18n.ts'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { findPreset } from '../shared/presets.ts'
import { normalizeProviderInput, validateUpstreamGateway } from '../shared/provider-input.ts'
import {
  OFFICIAL_PROVIDER_ID,
  type AppConfig,
  type AppSettings,
  type Provider,
  type ProviderInput,
  type ProviderView,
} from '../shared/types.ts'
import type { Target } from './proxy/server.ts'

export interface SecretBox {
  available(): boolean
  encrypt(plain: string): string
  decrypt(stored: string): string
}

type StoredProvider = Provider & { encryptedHeaders?: string }
type StoredConfig = Omit<AppConfig, 'providers'> & { providers: StoredProvider[] }

export function defaultSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    language: 'en',
    proxyPort: 18920,
    upstreamGateway: 'https://phoenix-gw.alibaba.com',
    accioExePath: '',
    networkProxy: 'system',
    networkProxyUrl: '',
    launchAccioOnStart: false,
    minimizeToTray: true,
    openAtLogin: false,
    debugCapture: false,
    upstreamIdleTimeoutSeconds: 180,
    theme: 'system',
    autoBackup: false,
    backupRetention: 7,
    ...overrides,
  }
}

export function validateSettings(settings: AppSettings, loadingLegacy = false): AppSettings {
  if (settings.autoBackup !== undefined && typeof settings.autoBackup !== 'boolean') throw new Error(tx("Invalid automatic backup setting", "自动备份设置无效"))
  if (settings.backupRetention !== undefined && (!Number.isInteger(settings.backupRetention) || settings.backupRetention < 1 || settings.backupRetention > 30)) throw new Error(tx("Keep between 1 and 30 automatic backups per account", "每个账号可保留 1 到 30 份自动备份"))
  const language = settings.language ?? 'en'
  if (language !== 'en' && language !== 'zh-CN') throw new Error(tr('语言设置无效'))
  if (!Number.isInteger(settings.proxyPort) || settings.proxyPort < 1024 || settings.proxyPort > 65535) throw new Error(tr("代理端口必须是 1024–65535 的整数"))
  if (!['system', 'direct', 'custom'].includes(settings.networkProxy)) throw new Error(tr("出站代理模式无效"))
  if (!['system', 'light', 'dark'].includes(settings.theme)) throw new Error(tr("主题设置无效"))
  for (const key of ['launchAccioOnStart', 'minimizeToTray', 'openAtLogin', 'debugCapture'] as const) {
    if (typeof settings[key] !== 'boolean') throw new Error(tr("设置 {0} 无效", key))
  }
  if (typeof settings.accioExePath !== 'string' || typeof settings.networkProxyUrl !== 'string') throw new Error(tr("路径或代理地址格式无效"))
  validateUpstreamGateway(settings.upstreamGateway, loadingLegacy)
  if (settings.networkProxy === 'custom') {
    let proxy: URL
    try { proxy = new URL(settings.networkProxyUrl.trim()) } catch { throw new Error(tr("请填写自定义代理地址，例如 http://127.0.0.1:7890")) }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash || (proxy.pathname && proxy.pathname !== '/')) throw new Error(tr("代理地址仅支持不带账号密码和路径的 HTTP、HTTPS、SOCKS4 或 SOCKS5 地址"))
  }
  const idle = settings.upstreamIdleTimeoutSeconds ?? 180
  if (!Number.isInteger(idle) || idle < 30 || idle > 3600) throw new Error(tr("无进展等待时间必须是 30–3600 秒的整数"))
  return { ...settings, language, networkProxyUrl: settings.networkProxyUrl.trim(), upstreamIdleTimeoutSeconds: idle }
}

export function maskKey(key: string): string {
  if (!key) return ''
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 3)}••••${key.slice(-4)}`
}

function newId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export class ConfigStore extends EventEmitter {
  private file: string
  private box: SecretBox
  private config: StoredConfig
  private committed: StoredConfig
  private defaults: Partial<AppSettings>
  loadError?: string

  constructor(file: string, box: SecretBox, settingsDefaults: Partial<AppSettings> = {}) {
    super()
    this.file = file
    this.box = box
    this.defaults = settingsDefaults
    this.config = this.load(settingsDefaults)
    this.committed = structuredClone(this.config)
  }

  private load(settingsDefaults: Partial<AppSettings>): StoredConfig {
    const fallback: AppConfig = { version: 1, activeProviderId: OFFICIAL_PROVIDER_ID, providers: [], settings: defaultSettings(settingsDefaults) }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StoredConfig>
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.version !== undefined && raw.version !== 1) || !Array.isArray(raw.providers)) throw new Error(tr("配置格式或版本无效"))
      const ids = new Set<string>()
      for (const p of raw.providers) {
        if (!p || typeof p.id !== 'string' || !p.id || p.id === OFFICIAL_PROVIDER_ID || ids.has(p.id) || !['openai', 'anthropic', 'gemini'].includes(p.kind) || ['name', 'baseUrl', 'model', 'apiKey'].some((k) => typeof p[k as keyof Provider] !== 'string')) throw new Error(tr("供应商配置不完整或标识重复"))
        if (p.modelOverrides && (typeof p.modelOverrides !== 'object' || Array.isArray(p.modelOverrides) || Object.values(p.modelOverrides).some((v) => typeof v !== 'string'))) throw new Error(tr("模型映射格式无效"))
        if (p.extraHeaders && (typeof p.extraHeaders !== 'object' || Array.isArray(p.extraHeaders) || Object.values(p.extraHeaders).some((v) => typeof v !== 'string'))) throw new Error(tr("自定义请求头格式无效"))
        if (p.encryptedHeaders !== undefined && typeof p.encryptedHeaders !== 'string') throw new Error(tr("加密请求头格式无效"))
        ids.add(p.id)
      }
      const active = raw.activeProviderId ?? OFFICIAL_PROVIDER_ID
      if (active !== OFFICIAL_PROVIDER_ID && !ids.has(active)) throw new Error(tr("当前选中的供应商不存在"))
      const loaded: AppConfig = {
        version: 1,
        activeProviderId: active,
        providers: (raw.providers ?? []).map((p) => ({ ...p, modelOverrides: p.modelOverrides ?? {} })),
        // Keep old HTTP configurations editable; the forwarding boundary still rejects them.
        settings: validateSettings({ ...defaultSettings(settingsDefaults), ...(raw.settings ?? {}) }, true),
      }
      this.loadError = undefined
      return loaded
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.loadError = undefined
      else this.loadError = tr("配置读取失败，原文件已保留，暂时禁止保存和接入。{0}", e instanceof SyntaxError ? tr("文件内容不是有效的 JSON。") : e instanceof Error ? e.message : String(e))
      return fallback
    }
  }

  assertWritable(): void {
    if (this.loadError) throw new Error(this.loadError)
  }

  restoreSnapshot(raw: string): void {
    this.assertWritable()
    const temp = `${this.file}.restore-check-${Date.now()}`
    try {
      fs.writeFileSync(temp, raw, { flag: 'wx' })
      const candidate = new ConfigStore(temp, this.box, this.defaults)
      if (candidate.loadError || candidate.providerViews().some((p) => p.keyError)) throw new Error(tx("Backup configuration or encrypted keys could not be read", "无法读取备份配置或加密密钥"))
      // Resume deliberately after restoring: do not launch Accio or create backups automatically.
      candidate.config.settings.launchAccioOnStart = false
      candidate.config.settings.autoBackup = false
      candidate.config.activeProviderId = OFFICIAL_PROVIDER_ID
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.before-restore-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL)
      this.config = candidate.config
      this.save()
    } finally { fs.rmSync(temp, { force: true }) }
  }

  /** Explicit recovery only; resetting first preserves the unreadable file byte-for-byte. */
  recover(action: 'retry' | 'reset'): void {
    if (action === 'retry') {
      const loaded = this.load(this.defaults)
      if (this.loadError) throw new Error(this.loadError)
      this.config = loaded
      this.committed = structuredClone(loaded)
      this.emit('change')
    } else if (action === 'reset' && this.loadError) {
      fs.copyFileSync(this.file, `${this.file}.recovery-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL)
      const error = this.loadError
      this.loadError = undefined
      this.config = { version: 1, activeProviderId: OFFICIAL_PROVIDER_ID, providers: [], settings: defaultSettings(this.defaults) }
      try { this.save() } catch (e) { this.loadError = error; throw e }
    }
  }

  private save(): void {
    try {
      this.assertWritable()
      for (const p of this.config.providers) {
        if (p.extraHeaders) {
          p.encryptedHeaders = Object.keys(p.extraHeaders).length ? this.box.encrypt(JSON.stringify(p.extraHeaders)) : undefined
          delete p.extraHeaders
        }
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2))
      fs.renameSync(tmp, this.file)
    } catch (e) {
      this.config = structuredClone(this.committed)
      throw e
    }
    this.committed = structuredClone(this.config)
    this.emit('change')
  }

  get settings(): AppSettings {
    return this.config.settings
  }

  get activeProviderId(): string {
    return this.config.activeProviderId
  }

  providerViews(): ProviderView[] {
    return this.config.providers.map(({ apiKey, encryptedHeaders, extraHeaders, ...rest }) => {
      try {
        const plain = this.reveal(apiKey)
        return { ...rest, extraHeaders: this.revealHeaders({ encryptedHeaders, extraHeaders }), apiKeyMasked: maskKey(plain), hasApiKey: Boolean(plain) }
      } catch {
        return { ...rest, apiKeyMasked: '', hasApiKey: Boolean(apiKey), keyError: tr("已保存的凭据无法解密，请在原 Windows 账户下打开，或重新填写 Key 和自定义请求头") }
      }
    })
  }

  private revealHeaders(p: Pick<StoredProvider, 'extraHeaders' | 'encryptedHeaders'>): Record<string, string> | undefined {
    if (!p.encryptedHeaders) return p.extraHeaders
    try {
      const headers = JSON.parse(this.box.decrypt(p.encryptedHeaders))
      if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some((v) => typeof v !== 'string')) throw new Error('invalid headers')
      return headers
    } catch { throw new Error(tr("已保存的自定义请求头无法解密，请在原 Windows 账户下打开，或重新填写请求头")) }
  }

  private reveal(stored: string): string {
    if (!stored) return ''
    try {
      return this.box.decrypt(stored)
    } catch {
      throw new Error(tr("已保存的 API Key 无法解密，请在原 Windows 账户下打开，或重新填写 Key"))
    }
  }

  /** Provider with its key decrypted — main process only. */
  provider(id: string): Provider | undefined {
    const p = this.config.providers.find((x) => x.id === id)
    if (!p) return undefined
    const { encryptedHeaders, ...rest } = p
    return { ...rest, extraHeaders: this.revealHeaders(p), apiKey: this.reveal(p.apiKey) }
  }

  resolveTarget(): Target {
    this.assertWritable()
    if (this.config.activeProviderId === OFFICIAL_PROVIDER_ID) return { mode: 'official' }
    const p = this.provider(this.config.activeProviderId)
    if (!p) throw new Error(tr("当前供应商不存在，请重新选择模型来源"))
    return { mode: 'byok', provider: p }
  }

  /** Build a provider from unsaved form input (used for "test" and "fetch models"). */
  draft(input: ProviderInput): Provider {
    input = normalizeProviderInput(input)
    this.assertWritable()
    const existing = input.id ? this.config.providers.find((p) => p.id === input.id) : undefined
    return {
      ...input,
      id: input.id ?? 'draft',
      createdAt: existing?.createdAt ?? Date.now(),
      modelOverrides: input.modelOverrides ?? {},
      apiKey: input.apiKey !== undefined ? input.apiKey : this.reveal(existing?.apiKey ?? ''),
      extraHeaders: input.authMode?.endsWith('-oauth') || input.authMode === 'subscription-key' ? undefined : input.extraHeaders ?? (existing ? this.revealHeaders(existing) : undefined),
    }
  }

  saveProvider(input: ProviderInput, activate = false): ProviderView {
    this.assertWritable()
    input = normalizeProviderInput(input, true)
    const idx = input.id ? this.config.providers.findIndex((p) => p.id === input.id) : -1
    const prev = idx >= 0 ? this.config.providers[idx] : undefined
    const apiKey = input.authMode?.endsWith('-oauth') || input.authMode === 'none' ? '' : input.apiKey !== undefined ? (input.apiKey ? this.box.encrypt(input.apiKey.trim()) : '') : (prev?.apiKey ?? '')
    const next: StoredProvider = {
      ...input,
      id: prev?.id ?? newId(),
      createdAt: prev?.createdAt ?? Date.now(),
      name: input.name.trim() || findPreset(input.presetId)?.name || tr("未命名供应商"),
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
      model: input.model.trim(),
      modelOverrides: Object.fromEntries(Object.entries(input.modelOverrides ?? {}).filter(([k, v]) => k.trim() && v.trim())),
      apiKey,
      extraHeaders: input.authMode?.endsWith('-oauth') || input.authMode === 'subscription-key' ? undefined : input.extraHeaders ?? (prev ? this.revealHeaders(prev) : undefined),
    }
    if (idx >= 0) this.config.providers[idx] = next
    else this.config.providers.push(next)
    if (activate) this.config.activeProviderId = next.id
    this.save()
    return this.providerViews().find((p) => p.id === next.id)!
  }

  deleteProvider(id: string): void {
    this.config.providers = this.config.providers.filter((p) => p.id !== id)
    if (this.config.activeProviderId === id) this.config.activeProviderId = OFFICIAL_PROVIDER_ID
    this.save()
  }

  duplicateProvider(id: string): ProviderView | undefined {
    const p = this.config.providers.find((x) => x.id === id)
    if (!p) return undefined
    const copy: Provider = { ...p, id: newId(), name: tr("{0} 副本", p.name), createdAt: Date.now(), modelOverrides: { ...p.modelOverrides } }
    this.config.providers.splice(this.config.providers.indexOf(p) + 1, 0, copy)
    this.save()
    return this.providerViews().find((v) => v.id === copy.id)
  }

  reorder(ids: string[]): void {
    const order = new Map(ids.map((id, i) => [id, i]))
    this.config.providers.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
    this.save()
  }

  setActive(id: string): void {
    if (id !== OFFICIAL_PROVIDER_ID && !this.config.providers.some((p) => p.id === id)) throw new Error(tr("供应商不存在"))
    if (id !== OFFICIAL_PROVIDER_ID) normalizeProviderInput(this.provider(id)!, true)
    this.config.activeProviderId = id
    this.save()
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.config.settings = validateSettings({ ...this.config.settings, ...patch })
    this.save()
    return this.config.settings
  }
}
