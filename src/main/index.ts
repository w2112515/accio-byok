import { setLanguage, tr, tx } from '../shared/i18n.ts'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, session, shell, Tray } from 'electron'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import iconPath from '../../resources/icon.png?asset'
import trayIconPath from '../../resources/tray.png?asset'
import type { AccioSwitchApi, AppState } from '../shared/api.ts'
import type { AutoBackupStatus } from '../shared/types.ts'
import { OFFICIAL_PROVIDER_ID, type AccioStatus, type AppEvent, type AppSettings, type ProviderInput, type TestResult, type TestScope } from '../shared/types.ts'
import {
  ACCIO_APPDATA,
  ACCIO_DIR,
  detectUpstreamGateway,
  findAccioExe,
  findAccioExeFromRegistry,
  launchAccio,
  listAccioPids,
  readModelCatalog,
  readAccioVersion,
  stopAccio,
} from './accio.ts'
import { ConfigStore, validateSettings, type SecretBox } from './config.ts'
import { LogStore } from './logs.ts'
import { parseAccioRequest } from './proxy/accio.ts'
import { ADAPTERS, resolveTargetModel, streamByok } from './proxy/byok.ts'
import { ModelListCache } from './model-list.ts'
import { protectedFetch, redactProviderError } from './proxy/request-policy.ts'
import { ProxyServer } from './proxy/server.ts'
import { SessionManager } from './sessions.ts'
import { AuthorizationStore } from './authorization.ts'
import { ConnectionChecks, connectionFingerprint } from './connection-checks.ts'
import { checkNeedsReview } from '../shared/connection-status.ts'
import { fundingLabel } from '../shared/provider-access.ts'
import { usableModelInfo } from '../shared/model-info.ts'
import { Maintenance, diagnosticPreview } from './maintenance.ts'
import type { DiagnosticPreview } from '../shared/types.ts'
import { readProviderUsage } from './provider-usage.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
setLanguage('en')

// Keep the established data and Chromium session location when changing the display name.
const dataDirectory = process.env.ASW_USER_DATA || path.join(app.getPath('appData'), 'Accio Switch')
fs.mkdirSync(dataDirectory, { recursive: true })
app.setPath('userData', dataDirectory)
app.setPath('sessionData', dataDirectory)

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.setAppUserModelId('app.accio-switch')
Menu.setApplicationMenu(null)

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let trayHintShown = false
let lastAccioSeen = 0
let launchedPid: number | undefined
let launchStartedAt: number | undefined
let busyOperation: string | undefined
let operationError: string | undefined
let accioOperation: AccioStatus['operation']
let accioError: string | undefined
let networkTests = 0
let networkChanging = false
let accioState: AccioStatus = { installed: false, exePath: '', running: false, pids: [], takenOver: false, launchedByUs: false }

let config: ConfigStore
let logs: LogStore
let sessions: SessionManager
let proxy: ProxyServer
let netFetch: ReturnType<typeof protectedFetch>
let authorizations: AuthorizationStore
let connectionChecks: ConnectionChecks
let maintenance: Maintenance
let diagnostics: DiagnosticPreview | undefined
let accioVersion: string | undefined
let autoBackupStatus: AutoBackupStatus = { state: 'disabled' }
const modelLists = new ModelListCache()

const box: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(tr("系统密钥加密暂不可用，未保存 API Key；请恢复系统加密服务后重试"))
    return `enc:${safeStorage.encryptString(s).toString('base64')}`
  },
  decrypt: (s) => {
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'))
    if (s.startsWith('plain:')) return Buffer.from(s.slice(6), 'base64').toString('utf8')
    return s
  },
}

function broadcast(e: AppEvent): void {
  win?.webContents.send('app:event', e)
}

function supportsMica(): boolean {
  const build = Number(os.release().split('.')[2] ?? 0)
  return process.platform === 'win32' && build >= 22000
}

function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors
  return { color: '#00000000', symbolColor: dark ? '#E4E4E7' : '#27272A', height: 48 }
}

function resolveExe(): string {
  return findAccioExe(config.settings.accioExePath)
}

// ---------------------------------------------------------------------------
// Network: BYOK traffic goes through Chromium's stack so it honours system proxies.

async function applyNetworkProxy(s: AppSettings = config.settings): Promise<void> {
  modelLists.clear()
  const ses = session.fromPartition('persist:accio-switch-net')
  if (s.networkProxy === 'direct') await ses.setProxy({ mode: 'direct' })
  else if (s.networkProxy === 'custom' && s.networkProxyUrl.trim()) await ses.setProxy({ proxyRules: s.networkProxyUrl.trim(), proxyBypassRules: '<local>' })
  else await ses.setProxy({ mode: 'system' })
  await ses.closeAllConnections()
}

async function startProxy() {
  config.assertWritable()
  if (proxy.activeRequests) throw new Error(tr("仍有请求进行中，请等待完成后再重启代理"))
  const boundPort = proxy.status.port
  const st = await proxy.start(boundPort || config.settings.proxyPort, !boundPort)
  lastAccioSeen = 0
  broadcast({ type: 'status' })
  if (!st.running) throw new Error(tr("本地代理未能启动：{0}", st.error ?? tr("端口不可用")))
  return st
}

async function runOperation<T>(name: string, action: () => Promise<T> | T): Promise<T> {
  if (busyOperation) throw new Error(tr("正在{0}，请等待完成后重试", busyOperation))
  busyOperation = name
  operationError = undefined
  broadcast({ type: 'status' })
  try { return await action() } catch (e) {
    operationError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    busyOperation = undefined
    broadcast({ type: 'status' })
  }
}

// ---------------------------------------------------------------------------
// Accio control

async function refreshAccio(): Promise<AccioStatus> {
  const exe = resolveExe()
  const pids = await listAccioPids()
  const running = pids.length > 0
  if (!running && !accioOperation) { launchedPid = undefined; lastAccioSeen = 0; launchStartedAt = undefined }
  const launchedByUs = Boolean(launchedPid && pids.includes(launchedPid))
  if (launchedPid && !launchedByUs) { launchedPid = undefined; lastAccioSeen = 0 }
  const next: AccioStatus = {
    installed: Boolean(exe),
    exePath: exe,
    running,
    pids,
    takenOver: running && proxy.status.running && lastAccioSeen > 0,
    lastSeenAt: lastAccioSeen || undefined,
    launchedByUs,
    startedAt: launchStartedAt,
    operation: accioOperation,
    error: accioError,
  }
  const changed = JSON.stringify({ ...next, lastSeenAt: 0 }) !== JSON.stringify({ ...accioState, lastSeenAt: 0 })
  accioState = next
  if (changed) {
    broadcast({ type: 'status' })
    rebuildTray()
  }
  return next
}

async function takeoverAccio(): Promise<AccioStatus> {
  return runOperation(tr("启动 Accio"), async () => {
  config.assertWritable()
  config.resolveTarget()
  accioOperation = 'starting'
  accioError = undefined
  try {
  const exe = resolveExe()
  if (!exe) throw new Error(tr("没有找到 Accio，请在「设置」中指定 Accio.exe 的位置"))
  if (!proxy.status.running) await startProxy()
  if (!proxy.status.running) throw new Error(tr("本地代理未能启动：{0}", proxy.status.error ?? ''))
  await stopAccio()
  launchedPid = undefined
  lastAccioSeen = 0
  launchStartedAt = Date.now()
  await launchAccio(exe, proxy.status.url)
  // The spawned process is a launcher stub for some installs; remember whatever runs next.
  await new Promise((r) => setTimeout(r, 2500))
  const pids = await listAccioPids()
  if (!pids.length) throw new Error(tr("Accio 启动后未检测到运行进程，请检查程序位置或手动启动查看错误"))
  launchedPid = pids[0]
  } catch (e) {
    accioError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    accioOperation = undefined
    await refreshAccio()
  }
  return accioState
  })
}

async function launchDirect(): Promise<AccioStatus> {
  return runOperation(tr("恢复官方直连"), async () => {
  accioOperation = 'direct'
  accioError = undefined
  try {
  const exe = resolveExe()
  if (!exe) throw new Error(tr("没有找到 Accio"))
  await stopAccio()
  launchedPid = undefined
  lastAccioSeen = 0
  launchStartedAt = undefined
  await launchAccio(exe)
  await new Promise((r) => setTimeout(r, 1500))
  if (!(await listAccioPids()).length) throw new Error(tr("未检测到直连启动的 Accio，代理已保留，请重试或手动启动 Accio"))
  } catch (e) {
    accioError = e instanceof Error ? e.message : String(e)
    throw e
  } finally {
    accioOperation = undefined
    await refreshAccio()
  }
  return accioState
  })
}

// ---------------------------------------------------------------------------
// Failures happen while the user is in Accio, not here: surface them, at most once per
// provider every few minutes, and open the matching log on click.

const lastFailureNotice = new Map<string, number>()

function notifyFailure(providerId: string, providerName: string, error: string, logId: string): void {
  if (win?.isFocused() || !Notification.isSupported()) return
  const now = Date.now()
  if (now - (lastFailureNotice.get(providerId) ?? 0) < 3 * 60_000) return
  lastFailureNotice.set(providerId, now)
  const n = new Notification({
    title: tr("{0} 请求失败", providerName),
    body: tr("{0}\n点击查看详情，或在托盘中切换来源。", error.replace(/^\[Accio (?:Switch|BYOK)\]\s*/, '').slice(0, 140)),
    icon: iconPath,
  })
  n.on('click', () => {
    showWindow()
    broadcast({ type: 'navigate', page: 'usage', intent: `log:${logId}` })
  })
  n.show()
}

// ---------------------------------------------------------------------------
// Provider test

async function probeProvider(input: ProviderInput, scope: TestScope = 'text'): Promise<TestResult> {
  if (busyOperation) throw new Error(tr("正在{0}，请稍后测试", busyOperation))
  if (!['text', 'tools', 'image', 'multiturn'].includes(scope)) throw new Error(tr("未知的检测类型"))
  const provider = { ...await authorizations.prepare(config.draft(input)), maxOutputTokens: 1024, thinking: 'off' as const, sendReasoningEffort: false }
  networkTests++
  try {
  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  let out = ''
  const toolProbe = scope === 'tools' || scope === 'multiturn'
  // Synthetic fixtures only: no user conversation, files, or executable tools.
  const prompt = toolProbe ? 'Call the connection_probe tool with value "pong". Do not answer with text. After the tool returns, reply with the exact result value.' : scope === 'image' ? 'What is the dominant color of this image? Reply with one English color word.' : 'Reply with the single word: pong'
  const redSquare = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg=='
  const probeRequest = { model: 'test', max_output_tokens: 1024, include_thoughts: scope === 'multiturn',
      tools: toolProbe ? [{ name: 'connection_probe', description: 'A harmless connection check. Returns a synthetic result and performs no action.', parameters_json: JSON.stringify({ type: 'object', properties: { value: { type: 'string', enum: ['pong'] } }, required: ['value'], additionalProperties: false }) }] : [],
      contents: [{ role: 'user', parts: [{ text: prompt }, ...(scope === 'image' ? [{ inline_data: { mime_type: 'image/png', data: redSquare } }] : [])] }] }
  let result = await streamByok({
    req: parseAccioRequest(probeRequest),
    provider,
    model: provider.model,
    fetch: netFetch,
    signal: ctrl.signal,
    write: (c) => (out += c),
  })
  let text = ''
  let validCall = false
  const modelParts: Record<string, any>[] = []
  let probeCall: { id: string; name: string } | undefined
  for (const block of out.split('\n\n')) {
    if (!block.startsWith('data: ') || block.includes('[DONE]')) continue
    try {
      const f = JSON.parse(block.slice(6))
      for (const p of f.content?.parts ?? []) {
        modelParts.push(p)
        if (typeof p.text === 'string' && !p.thought) text += p.text
        if (f.turnComplete && p.functionCall?.name === 'connection_probe') {
          const args = JSON.parse(p.functionCall.argsJson)
          validCall ||= args.value === 'pong' && Object.keys(args).length === 1
          if (validCall) probeCall = p.functionCall
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (scope === 'multiturn' && validCall && probeCall && result.status === 'ok') {
    out = ''
    result = await streamByok({
      req: parseAccioRequest({ ...probeRequest, contents: [...probeRequest.contents, { role: 'model', parts: modelParts }, { role: 'user', parts: [{ functionResponse: { ...probeCall, responseJson: JSON.stringify({ result: 'violet-73' }) } }] }] }),
      provider, model: provider.model, fetch: netFetch, signal: ctrl.signal, write: (c) => { out += c },
    })
    text = ''
    for (const block of out.split('\n\n')) {
      if (!block.startsWith('data: ') || block.includes('[DONE]')) continue
      try { for (const p of JSON.parse(block.slice(6)).content?.parts ?? []) if (typeof p.text === 'string' && !p.thought) text += p.text } catch { /* Non-JSON framing is not a result. */ }
    }
    validCall = text.trim() === 'violet-73' && result.toolCalls === 0
  } else if (scope === 'multiturn') validCall = false
  clearTimeout(timer)
  if (result.errorCode === 'subscription_sharing_usage_limit_exceeded' && provider.credentialId) {
    authorizations.pause(provider.credentialId, tx('Requests paused after a ChatGPT usage limit. Manage usage, then explicitly resume.', 'ChatGPT 用量受限后已暂停请求，请管理用量后手动恢复。'))
    broadcast({ type: 'config' })
  }
  const stamp = { scope, checkedAt: Date.now(), notSent: result.notSent, protection: netFetch.inspect(provider.baseUrl, { headers: ADAPTERS[provider.kind].headers(provider) }) }
  if (result.status === 'aborted') return { ...stamp, ok: false, latencyMs: Date.now() - started, model: provider.model, message: tr("请求超时（60 秒）；供应商可能已计费") }
  const passed = toolProbe ? validCall : scope === 'image' ? /\bred\b/i.test(text) : !!text.trim()
  return {
    ...stamp,
    ok: result.status === 'ok' && passed,
    latencyMs: result.ttftMs ?? Date.now() - started,
    model: provider.model,
    message: result.status !== 'ok' ? (result.error ?? tr("未知错误")) : scope === 'multiturn' ? validCall ? tx('Tool call → synthetic result → exact final reply passed. No tool was executed.', '工具调用→合成结果→准确最终回复通过，未执行真实工具。') : tx('Tool round trip did not return the expected final result.', '工具多轮续接未返回预期最终结果。') : scope === 'tools' ? validCall ? tr("收到名称和参数正确的工具调用；未执行工具。多轮工具任务仍需在 Accio 验证。") : tr("未收到预期的工具调用，本次检测未通过。") : scope === 'image' ? passed ? tr("正确识别测试图片的红色。复杂图像仍需单独验证。") : tr("未识别出测试图片颜色，本次检测未通过。返回：{0}", text.slice(0, 100)) : text.trim().slice(0, 160) || tr("未返回可见文本，本次检测未通过。"),
  }
  } finally { networkTests-- }
}

// ---------------------------------------------------------------------------
// IPC

async function testProvider(input: ProviderInput, scope: TestScope = 'text'): Promise<TestResult> {
  const submitted = config.draft(input)
  if (submitted.authMode === 'subscription-key' && submitted.presetId === 'dashscope') return { ok: false, scope, checkedAt: Date.now(), latencyMs: 0, model: submitted.model, notSent: true, message: tx('This plan excludes API test tools. Save the connection and verify with a permitted interactive task in Accio.', '此套餐不允许 API 测试工具。请保存连接，并在 Accio 中通过符合规则的交互任务验证。') }
  const result = await probeProvider(input, scope)
  connectionChecks.add(submitted, result)
  broadcast({ type: 'config' })
  return result
}

async function activateWithReview(id: string): Promise<void> {
  if (id === config.activeProviderId) return
  const next = id === OFFICIAL_PROVIDER_ID ? undefined : config.provider(id)
  if (id !== OFFICIAL_PROVIDER_ID && !next) throw new Error(tr('供应商不存在'))
  if (next?.authMode?.endsWith('-oauth')) {
    const account = authorizations.views().find((a) => a.id === next.credentialId)
    if (account?.pauseReason) throw new Error(account.pauseReason)
    if (!account?.connected || !account.planEnabled) throw new Error(tx('Sign in and enable access before switching.', '请先登录并启用访问权限再切换。'))
  }
  const prev = config.provider(config.activeProviderId)
  const recent = prev ? logs.recent(50).find((entry) => entry.connectionFingerprint === connectionFingerprint(prev) && !entry.notSent && Date.now() - entry.ts < 30 * 60_000) : undefined
  const nextModel = next ? recent ? resolveTargetModel(next, recent.accioModel) : next.model : undefined
  const targetWindow = next ? usableModelInfo(next, nextModel)?.contextWindow : undefined
  const currentWindow = recent?.contextWindow ?? (prev ? usableModelInfo(prev)?.contextWindow : undefined)
  const lines = [
    next ? `${next.name} · ${next.model}\n${new URL(next.baseUrl).origin}\n${fundingLabel(next)}` : tx('Accio official gateway and account billing', 'Accio 官方网关及账号计费'),
    tx('Future requests, including the conversation context and tool results Accio sends, go to this destination. In-flight requests continue with their original provider.', '后续请求（包括 Accio 发来的会话上下文和工具结果）将发送到此目标；正在进行的请求仍使用原供应商。'),
  ]
  if (next && !targetWindow) lines.push(tx('Target context window is unknown. Check long conversations before continuing.', '目标上下文窗口未知，请先核对长会话是否适用。'))
  if (targetWindow && currentWindow && targetWindow < currentWindow) lines.push(tx('This model has a smaller context window. Compact or start a new conversation in Accio if needed.', '此模型的上下文窗口更小；必要时请在 Accio 整理或新建会话。'))
  if (targetWindow && recent?.estimatedInputTokens && recent.estimatedInputTokens >= targetWindow * 0.8) lines.push(tx(`The latest request's estimated input (${recent.estimatedInputTokens.toLocaleString()} tokens) is at least 80% of ${nextModel}'s window. This estimate is not a tokenizer count and may omit media. Compact or start a new conversation before continuing.`, `最近请求的估算输入（${recent.estimatedInputTokens.toLocaleString()} Token）已达到 ${nextModel} 窗口的 80%。这是估算，可能未计入图片等内容；继续前建议先整理或新建会话。`))
  if (next?.parameterMode === 'auto') lines.push(tx('Model parameters follow the actual mapped model. Accio’s automatic-compaction threshold remains controlled by Accio.', '参数会跟随实际映射模型，自动压缩阈值仍由 Accio 管理。'))
  if (next && !connectionChecks.get(next).some((c) => c.scope === 'multiturn' && c.ok && !checkNeedsReview(c))) lines.push(tx('Tool round-trip compatibility has no passing check from the last 30 days. Review it before continuing a tool-heavy task.', '此连接没有最近 30 天内通过的工具多轮检测，继续工具密集任务前请复核。'))
  if (prev && next && fundingLabel(prev) !== fundingLabel(next)) lines.push(tx('Billing source changes. Any API charges or subscription overage follow the destination settings.', '计费来源将改变，API 费用或订阅额外用量按目标服务设置执行。'))
  const result = await dialog.showMessageBox(win!, { type: 'question', title: tx('Switch model connection?', '切换模型连接？'), message: tx('Use this connection for the next request', '下一条请求使用此连接'), detail: lines.join('\n\n'), buttons: [tx('Switch connection', '切换连接'), tr('取消')], defaultId: 1, cancelId: 1, noLink: true })
  if (result.response !== 0) throw new Error(tx('Switch cancelled. The previous connection remains active.', '已取消切换，仍使用原连接。'))
  config.setActive(id)
}

async function automaticBackup(force = false): Promise<AutoBackupStatus> {
  if (!config.settings.autoBackup) return autoBackupStatus = { state: 'disabled' }
  if (!force && autoBackupStatus.state === 'error' && Date.now() - (autoBackupStatus.checkedAt ?? 0) < 15 * 60_000) return autoBackupStatus
  if (busyOperation) return autoBackupStatus
  autoBackupStatus = { ...autoBackupStatus, state: 'waiting', checkedAt: Date.now(), message: tx('Waiting until Accio is closed.', '等待 Accio 关闭。') }
  try {
    if ((await listAccioPids()).length) { broadcast({ type: 'status' }); return autoBackupStatus }
    await runOperation(tx('Creating automatic backups', '创建自动备份'), async () => {
      autoBackupStatus = { ...autoBackupStatus, state: 'running' }
      broadcast({ type: 'status' })
      const previous = await sessions.listBackups()
      const ids: string[] = []
      for (const account of await sessions.listAccounts()) {
        const last = previous.find((b) => b.accountId === account.id && b.consistency === 'closed')
        if (!force && last && (Date.now() - last.createdAt < 86_400_000 || account.modifiedAt <= last.createdAt)) continue
        const backup = await sessions.backup(account.id, 'automatic', undefined, 'closed')
        ids.push(backup.id)
        await sessions.pruneAutomatic(account.id, config.settings.backupRetention ?? 7)
      }
      autoBackupStatus = { state: 'ok', checkedAt: Date.now(), completedAt: ids.length ? Date.now() : autoBackupStatus.completedAt, lastBackupIds: ids.length ? ids : autoBackupStatus.lastBackupIds, message: ids.length ? tx(`Created ${ids.length} verified backups.`, `已创建 ${ids.length} 份通过校验的备份。`) : tx('No changed accounts are due for a daily backup.', '当前没有需要每日备份的已变更账号。') }
    })
  } catch (e) { autoBackupStatus = { ...autoBackupStatus, state: 'error', message: e instanceof Error ? e.message : String(e) } }
  broadcast({ type: 'status' })
  return autoBackupStatus
}

function state(): AppState {
  return {
    version: app.getVersion(),
    providers: config.providerViews().map((view) => {
      if (view.keyError || !netFetch) return view
      try {
        const p = config.provider(view.id)!
        return { ...view, connectionFingerprint: connectionFingerprint(p), authorization: authorizations?.views().find((a) => a.id === p.credentialId), checks: connectionChecks?.get(p), protection: netFetch.inspect(p.baseUrl, { headers: ADAPTERS[p.kind].headers(p) }) }
      } catch { return view }
    }),
    activeProviderId: config.activeProviderId,
    settings: config.settings,
    proxy: proxy.status,
    accio: { ...accioState, version: accioVersion },
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    dataDir: app.getPath('userData'),
    configError: config.loadError,
    operationError,
    busyOperation,
    authorizations: authorizations?.views(),
    authorizationError: authorizations?.loadError,
    autoBackup: config.settings.autoBackup ? autoBackupStatus : { state: 'disabled' },
  }
}

const api: AccioSwitchApi = {
  providerUsage: async (id) => {
    const saved = config.provider(id)
    if (!saved) throw new Error(tr('供应商不存在'))
    return readProviderUsage(await authorizations.prepare(saved), netFetch)
  },
  checkUpdate: () => maintenance.check(),
  restoreConfigBackup: () => runOperation(tx('Restoring configuration', '恢复配置'), async () => {
    if (proxy.activeRequests || networkTests || (await listAccioPids()).length) throw new Error(tx('Close Accio and finish requests first.', '请先关闭 Accio 并等待请求结束。'))
    const pick = await dialog.showOpenDialog(win!, { defaultPath: path.join(dataDirectory, 'updates'), properties: ['openFile'], filters: [{ name: 'Encrypted configuration', extensions: ['enc'] }] })
    if (pick.canceled || !pick.filePaths[0]) return
    const file = pick.filePaths[0]
    if ((await fs.promises.stat(file)).size > 10 * 1024 * 1024) throw new Error('Configuration backup is too large')
    const backup = JSON.parse(box.decrypt(await fs.promises.readFile(file, 'utf8')))
    if (backup.version !== app.getVersion() || typeof backup.config !== 'string' || backup.credentialVaultExcluded !== true) throw new Error(tx('Open the app version that created this configuration backup before restoring it.', '请使用生成此配置备份的应用版本进行恢复。'))
    const confirm = await dialog.showMessageBox(win!, { type: 'question', message: tx('Restore these connection profiles and settings?', '恢复此备份中的连接和设置？'), detail: tx('The current configuration will be preserved. Selection returns to Accio official; automatic startup and backups are disabled until you review them. OAuth tokens are unchanged.', '会保留当前配置副本，恢复后切回 Accio 官方，并关闭自动启动和自动备份以待核对。OAuth 令牌保持现状。'), buttons: [tx('Restore configuration', '恢复配置'), tr('取消')], defaultId: 1, cancelId: 1 })
    if (confirm.response !== 0) return
    config.restoreSnapshot(backup.config)
    await applyNetworkProxy(); await startProxy(); broadcast({ type: 'config' })
  }),
  downloadUpdate: (name) => runOperation(tx('Downloading update', '下载更新'), () => maintenance.download(name)),
  installUpdate: () => runOperation(tx('Starting update', '启动更新'), async () => {
    if (proxy.activeRequests || networkTests || (await listAccioPids()).length) throw new Error(tx('Close Accio and finish active requests before installing.', '安装前请先关闭 Accio 并等待请求完成。'))
    const installer = await maintenance.verifiedInstallPath()
    const result = await dialog.showMessageBox(win!, { type: 'question', message: tx('Open the verified update and quit Accio BYOK?', '打开已校验更新并退出 Accio BYOK？'), detail: tx('An encrypted configuration backup has been saved in the updates folder. Keep the previous executable. To roll back, use that version and restore its matching backup. OAuth credentials are excluded and must never be restored from an old token snapshot.', '已在 updates 目录保存加密配置备份，请保留原版本程序。回退时使用原版本及其对应配置备份；OAuth 凭据不在备份中，不可恢复旧令牌快照。'), buttons: [tx('Open update', '打开更新'), tr('取消')], defaultId: 1, cancelId: 1 })
    if (result.response !== 0) return
    const error = await shell.openPath(installer)
    if (error) throw new Error(error)
    quitting = true; app.quit()
  }),
  diagnosticPreview: async (includeContent = false) => {
    if (typeof includeContent !== 'boolean') throw new Error('Invalid diagnostic option')
    const recent = logs.recent(50)
    const captures = includeContent ? recent.map((l) => logs.capture(l.id)).filter((v): v is NonNullable<typeof v> => !!v).slice(0, 3) : undefined
    diagnostics = diagnosticPreview(app.getVersion(), { proxyRunning: proxy.status.running, accioRunning: accioState.running, accioVersion, providerCount: config.providerViews().length }, recent, captures, (s) => {
      s = authorizations.redact(s)
      for (const view of config.providerViews()) { const p = config.provider(view.id); if (p) for (const secret of [p.apiKey, ...Object.values(p.extraHeaders ?? {})]) if (secret) s = s.split(secret).join('[REDACTED]') }
      return s
    })
    return diagnostics
  },
  exportDiagnostic: async (id) => {
    if (!diagnostics || diagnostics.id !== id) throw new Error('Preview the diagnostic report again before exporting')
    const snapshot = diagnostics
    const save = await dialog.showSaveDialog(win!, { defaultPath: `Accio-BYOK-diagnostic-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
    if (save.canceled || !save.filePath) return undefined
    await fs.promises.writeFile(save.filePath, snapshot.content, 'utf8')
    return save.filePath
  },
  signIn: async (service, existingId) => {
    config.assertWritable()
    const result = await authorizations.signIn(service, (url) => shell.openExternal(url), existingId)
    modelLists.clear()
    broadcast({ type: 'config' })
    return result
  },
  cancelSignIn: async () => authorizations.cancel(),
  resumeAuthorization: async (id) => { authorizations.resume(id); broadcast({ type: 'config' }) },
  signOut: (id) => runOperation('Signing out', async () => {
    if (proxy.activeRequests || networkTests) throw new Error('Wait for active requests and checks to finish before signing out')
    const result = await authorizations.signOut(id)
    modelLists.clear()
    broadcast({ type: 'config' })
    return result
  }),
  getState: async () => state(),
  saveProvider: (input, activate) => runOperation(tr("保存供应商"), async () => {
    const saved = config.saveProvider(input)
    if (activate) await activateWithReview(saved.id)
    return saved
  }),
  recoverConfig: (action) => runOperation(tr("恢复配置"), async () => {
    config.recover(action)
    await applyNetworkProxy()
    await startProxy()
    nativeTheme.themeSource = config.settings.theme
    await refreshAccio()
  }),
  deleteProvider: (id) => runOperation(tr("删除供应商"), () => config.deleteProvider(id)),
  duplicateProvider: (id) => runOperation(tr("复制供应商"), () => config.duplicateProvider(id)),
  activateProvider: (id) => runOperation(tr("切换供应商"), () => activateWithReview(id)),
  reorderProviders: (ids) => runOperation(tr("调整供应商顺序"), () => config.reorder(ids)),
  testProvider,
  listProviderModels: async (input, refresh) => {
    if (busyOperation) throw new Error(tr("正在{0}，请稍后读取模型列表", busyOperation))
    const p = await authorizations.prepare(config.draft(input))
    networkTests++
    try { return await modelLists.list(p, netFetch, refresh) } catch (e) { throw new Error(redactProviderError(e instanceof Error ? e.message : String(e), p)) } finally { networkTests-- }
  },
  providerModelInfo: async (input) => {
    if (busyOperation) throw new Error(tr("正在{0}，请稍后读取模型信息", busyOperation))
    const p = await authorizations.prepare(config.draft(input))
    if (!p.model) throw new Error(tr("请先选择模型"))
    networkTests++
    try { return await modelLists.describe(p, netFetch) } catch (e) { throw new Error(redactProviderError(e instanceof Error ? e.message : String(e), p)) } finally { networkTests-- }
  },
  updateSettings: (patch) => runOperation(tr("应用设置"), async () => {
    config.assertWritable()
    const prev = config.settings
    const next = validateSettings({ ...prev, ...patch })
    const networkChanged = next.networkProxy !== prev.networkProxy || next.networkProxyUrl !== prev.networkProxyUrl
    const portChanged = next.proxyPort !== prev.proxyPort
    if (portChanged && (await refreshAccio()).running) throw new Error(tr("请先关闭 Accio，再修改本地代理端口"))
    if ((networkChanged || portChanged || next.upstreamGateway !== prev.upstreamGateway) && (proxy.activeRequests || networkTests)) throw new Error(tr("仍有请求或测试进行中，请等待完成后再修改网络设置"))
    const oldPort = proxy.status.port
    networkChanging = networkChanged
    try {
      if (networkChanged) await applyNetworkProxy(next)
      if (portChanged) {
        const st = await proxy.start(next.proxyPort, true)
        if (!st.running) throw new Error(tr("新端口未能启动：{0}", st.error))
        lastAccioSeen = 0
      }
      if (patch.openAtLogin !== undefined && app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.openAtLogin, args: ['--hidden'] })
      config.updateSettings(next)
    } catch (e) {
      const rollbackErrors: string[] = []
      if (networkChanged) await applyNetworkProxy(prev).catch((err) => rollbackErrors.push(tr("出站代理恢复失败：{0}", String(err))))
      if (portChanged) {
        const restored = await proxy.start(oldPort || prev.proxyPort, !oldPort)
        if (!restored.running) rollbackErrors.push(tr("本地端口恢复失败：{0}", restored.error))
      }
      if (patch.openAtLogin !== undefined && app.isPackaged) {
        try { app.setLoginItemSettings({ openAtLogin: prev.openAtLogin, args: ['--hidden'] }) } catch (err) { rollbackErrors.push(tr("自启恢复失败：{0}", String(err))) }
      }
      throw new Error(`${e instanceof Error ? e.message : String(e)}${rollbackErrors.length ? `；${rollbackErrors.join('；')}` : tr("；原配置已保留")}`)
    } finally { networkChanging = false }
    if (patch.debugCapture === false) logs.clearCaptures()
    if (patch.theme) nativeTheme.themeSource = next.theme
    return next
  }),
  restartProxy: () => runOperation(tr("重启代理"), startProxy),
  accioTakeover: takeoverAccio,
  accioStop: () => runOperation(tr("关闭 Accio"), async () => {
    await stopAccio()
    launchedPid = undefined
    lastAccioSeen = 0
    return refreshAccio()
  }),
  accioLaunchDirect: launchDirect,
  accioModels: async () => readModelCatalog(),
  browseAccioExe: async () => {
    const r = await dialog.showOpenDialog(win!, { title: tr("选择 Accio.exe"), filters: [{ name: 'Accio', extensions: ['exe'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return undefined
    await runOperation(tr("更新 Accio 位置"), () => config.updateSettings({ accioExePath: r.filePaths[0] }))
    accioVersion = await readAccioVersion(r.filePaths[0])
    await refreshAccio()
    return r.filePaths[0]
  },
  createDesktopShortcut: async () => {
    const target = path.join(app.getPath('desktop'), 'Accio (BYOK).lnk')
    const args = app.isPackaged ? '--launch-accio' : `"${app.getAppPath()}" --launch-accio`
    const exe = resolveExe()
    const ok = shell.writeShortcutLink(target, 'create', {
      target: process.execPath,
      args,
      icon: exe || process.execPath,
      iconIndex: 0,
      description: tr("通过 Accio BYOK 启动 Accio（使用你自己的模型 Key）"),
      appUserModelId: 'app.accio-switch',
    })
    if (!ok) throw new Error(tr("创建快捷方式失败"))
    return target
  },
  recentLogs: async (limit) => logs.recent(limit),
  usageStats: (days) => logs.stats(days),
  logCapture: async (id) => logs.capture(id),
  clearLogs: () => logs.clear(),
  listAccounts: () => sessions.listAccounts(),
  listBackups: () => sessions.listBackups(),
  previewBackup: (id, target) => sessions.preview(id, target),
  runAutoBackup: () => automaticBackup(true),
  createBackup: (accountId, note) => runOperation(tr("备份会话"), async () => sessions.backup(accountId, 'manual', note, (await listAccioPids()).length ? 'live' : 'closed')),
  restoreBackup: (id) => runOperation(tr("恢复会话"), async () => {
    if ((await listAccioPids()).length) throw new Error(tr("请先关闭 Accio 再恢复备份"))
    return sessions.restore(id)
  }),
  migrateBackup: (id, target) => runOperation(tr("迁移会话"), async () => {
    if ((await listAccioPids()).length) throw new Error(tr("请先关闭 Accio 再迁移会话"))
    return sessions.migrate(id, target)
  }),
  deleteBackup: (id) => runOperation(tr("删除备份"), () => sessions.deleteBackup(id)),
  openPath: async (p) => {
    await shell.openPath(p)
  },
  openExternal: async (url) => {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  },
}

ipcMain.handle('api', async (_e, method: keyof AccioSwitchApi, ...args: unknown[]) => {
  const fn = api[method] as ((...a: unknown[]) => Promise<unknown>) | undefined
  if (typeof fn !== 'function') throw new Error(`unknown method ${String(method)}`)
  return fn(...args)
})

// ---------------------------------------------------------------------------
// Window & tray

function createWindow(show = true): void {
  const mica = supportsMica()
  win = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 980,
    minHeight: 660,
    show: false,
    title: 'Accio BYOK',
    icon: iconPath,
    backgroundColor: mica ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#18181B' : '#F4F4F5',
    ...(mica ? { backgroundMaterial: 'mica' as const } : {}),
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.once('ready-to-show', () => {
    if (show) win?.show()
  })
  win.on('close', (e) => {
    if (quitting || !config.settings.minimizeToTray) return
    e.preventDefault()
    win?.hide()
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true
      new Notification({ title: tr("Accio BYOK 仍在后台运行"), body: tr("本地代理需要保持运行，Accio 才能使用你的模型。右键托盘图标可以快速切换或退出。"), icon: iconPath }).show()
    }
  })
  win.on('closed', () => (win = null))
  const url = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && url) win.loadURL(url)
  else win.loadFile(path.join(here, '../renderer/index.html'))
}

function showWindow(): void {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

function rebuildTray(): void {
  if (!tray) return
  const active = config.activeProviderId
  const providers = config.providerViews()
  const activeName = active === OFFICIAL_PROVIDER_ID ? tr("Accio 官方") : (providers.find((p) => p.id === active)?.name ?? tr("Accio 官方"))
  const choose = (id: string) => void api.activateProvider(id).catch((e) => dialog.showErrorBox(tr("无法切换供应商"), String(e?.message ?? e)))
  tray.setToolTip(`Accio BYOK · ${activeName}${accioState.takenOver ? tr(" · 代理已收到请求") : ''}`)
  const menu = Menu.buildFromTemplate([
    { label: tr("当前：{0}", activeName), enabled: false },
    { type: 'separator' },
    { label: tr("Accio 官方模型"), type: 'radio', checked: active === OFFICIAL_PROVIDER_ID, enabled: !busyOperation && !config.loadError, click: () => choose(OFFICIAL_PROVIDER_ID) },
    ...providers.map((p) => ({
      label: `${p.name}${p.model ? `  ·  ${p.model}` : ''}`,
      type: 'radio' as const,
      checked: active === p.id,
      enabled: !busyOperation && !config.loadError,
      click: () => choose(p.id),
    })),
    { type: 'separator' },
    {
      label: accioState.takenOver ? tr("重启 Accio") : accioState.running ? tr("接管 Accio（重启）") : tr("启动 Accio"),
      enabled: Boolean(accioState.installed) && !busyOperation && !config.loadError,
      click: () => confirmNativeLaunch().catch((e) => dialog.showErrorBox('Accio BYOK', String(e?.message ?? e))),
    },
    { label: tr("打开 Accio BYOK"), click: showWindow },
    { type: 'separator' },
    { label: tr("退出"), click: () => void quitApp().catch((e) => dialog.showErrorBox(tr("未能退出，代理已保留"), String(e?.message ?? e))) },
  ])
  tray.setContextMenu(menu)
}

function createTray(): void {
  const img = nativeImage.createFromPath(trayIconPath)
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }) : img)
  tray.on('click', showWindow)
  rebuildTray()
}

async function quitApp(): Promise<void> {
  if (busyOperation) {
    dialog.showErrorBox(tr("操作进行中"), tr("正在{0}，请完成后再退出", busyOperation))
    return
  }
  const st = await refreshAccio()
  if (st.running && (st.takenOver || st.launchedByUs)) {
    const parent = win && win.isVisible() ? win : undefined
    const opts = {
      type: 'warning' as const,
      buttons: [tr("退出，并让 Accio 恢复官方直连"), tr("仍然退出"), tr("取消")],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Accio BYOK',
      message: tr("Accio 正在通过 Accio BYOK 联网"),
      detail: tr("退出后本地代理会停止，正在运行的 Accio 将无法连接网络。可以让 Accio 以官方直连方式自动重启。"),
    }
    const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
    if (r.response === 2) return
    if (r.response === 0) {
      try { await launchDirect() } catch (e) {
        dialog.showErrorBox(tr("未能恢复官方直连，代理已保留"), e instanceof Error ? e.message : String(e))
        return
      }
    }
  }
  quitting = true
  await proxy.stop()
  tray?.destroy()
  app.quit()
}

async function confirmNativeLaunch(): Promise<void> {
  const st = await refreshAccio()
  if (st.running) {
    const choice = await dialog.showMessageBox({ type: 'warning', title: tr("重启 Accio？"), message: tr("接入会重启正在运行的 Accio"), detail: tr("正在生成的回复和运行中的任务会被中断，请先保存当前工作。"), buttons: [tr("重启并接入"), tr("取消")], defaultId: 1, cancelId: 1, noLink: true })
    if (choice.response !== 0) return
  }
  await takeoverAccio()
}

function handleArgs(argv: string[]): void {
  if (argv.includes('--launch-accio')) {
    refreshAccio()
      .then((st) => (st.takenOver || st.launchedByUs ? undefined : confirmNativeLaunch()))
      .catch((e) => dialog.showErrorBox('Accio BYOK', String(e?.message ?? e)))
  }
}

app.on('second-instance', (_e, argv) => {
  if (argv.includes('--launch-accio')) handleArgs(argv)
  else showWindow()
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  /* keep running in the tray */
})

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const exe = findAccioExe() || (await findAccioExeFromRegistry())
  config = new ConfigStore(path.join(userData, 'config.json'), box, { upstreamGateway: detectUpstreamGateway(), accioExePath: exe })
  setLanguage(config.settings.language ?? 'en')
  nativeTheme.themeSource = config.settings.theme
  logs = new LogStore(path.join(userData, 'logs'))
  sessions = new SessionManager({
    accioDir: ACCIO_DIR,
    backupDir: path.join(userData, 'backups'),
    rememberedAccountsFile: path.join(ACCIO_APPDATA, 'remembered-accounts.json'),
    beforeWrite: async () => {
      if ((await listAccioPids()).length) throw new Error(tr("检测到 Accio 重新启动，已停止会话写入。请关闭 Accio 后重试。"))
    },
  })
  const netSession = session.fromPartition('persist:accio-switch-net')
  netFetch = protectedFetch((url, init) => {
    if (networkChanging) throw new Error(tr("网络设置正在应用，请稍后重试"))
    return netSession.fetch(url, init as RequestInit)
  }, Date.now, () => broadcast({ type: 'status' }))
  try { await applyNetworkProxy() } catch (e) { operationError = tr("出站网络设置未能应用：{0}", e instanceof Error ? e.message : String(e)) }
  authorizations = new AuthorizationStore(path.join(userData, 'authorization.enc'), box, netFetch)
  maintenance = new Maintenance(userData, app.getVersion(), (url, init) => netSession.fetch(url, { ...init, credentials: 'omit' } as RequestInit), box)
  void readAccioVersion(findAccioExe(config.settings.accioExePath)).then((v) => { accioVersion = v; broadcast({ type: 'status' }) })
  connectionChecks = new ConnectionChecks(path.join(userData, 'connection-checks.json'))

  proxy = new ProxyServer({
    resolveTarget: () => config.resolveTarget(),
    prepareProvider: (p) => authorizations.prepare(p),
    upstream: () => config.settings.upstreamGateway,
    fetch: (url, init) => netFetch(url, init),
    onLog: (entry, capture, pricing) => {
      if (entry.errorCode === 'subscription_sharing_usage_limit_exceeded') {
        const p = config.provider(entry.providerId)
        if (p?.authMode === 'openai-oauth' && p.credentialId) {
          try { authorizations.pause(p.credentialId, tx('Requests paused after a ChatGPT usage limit. Manage usage, then explicitly resume.', 'ChatGPT 用量受限后已暂停请求，请管理用量后手动恢复。')); broadcast({ type: 'config' }) }
          catch (e) { operationError = String(e); broadcast({ type: 'status' }) }
        }
      }
      if (!config.settings.debugCapture) capture = undefined
      const log = logs.add(entry, pricing, capture)
      if (log.mode === 'byok' && log.status === 'error') notifyFailure(log.providerId, log.providerName, log.error ?? '', log.id)
    },
    onAccioSeen: () => {
      const wasStale = Date.now() - lastAccioSeen > 60_000
      lastAccioSeen = Date.now()
      if (wasStale) void refreshAccio().catch((e) => { operationError = String(e); broadcast({ type: 'status' }) })
    },
    debugCapture: () => config.settings.debugCapture,
    idleTimeoutMs: () => (config.settings.upstreamIdleTimeoutSeconds ?? 180) * 1000,
  })

  config.on('change', () => {
    setLanguage(config.settings.language ?? 'en')
    broadcast({ type: 'config' })
    rebuildTray()
  })
  logs.on('log', (entry) => broadcast({ type: 'log', entry }))
  logs.on('storage-error', (message) => broadcast({ type: 'storage-error', message }))
  logs.on('cleared', () => broadcast({ type: 'config' }))
  nativeTheme.on('updated', () => win?.setTitleBarOverlay(overlayColors()))

  if (!config.loadError && !operationError) {
    try { await startProxy() } catch (e) { operationError = e instanceof Error ? e.message : String(e) }
  }
  await refreshAccio().catch((e) => { operationError = String(e) })
  setInterval(() => void refreshAccio().catch((e) => { operationError = String(e); broadcast({ type: 'status' }) }), 4000)
  setInterval(() => void automaticBackup(), 60_000)
  if (config.settings.autoBackup) void automaticBackup()

  createTray()
  const hidden = process.argv.includes('--hidden') || process.argv.includes('--launch-accio')
  createWindow(!hidden)
  handleArgs(process.argv)
  if (config.settings.launchAccioOnStart && !accioState.running && !config.loadError) takeoverAccio().catch((e) => dialog.showErrorBox(tr("Accio 启动失败"), String(e?.message ?? e)))

  const shotDir = process.env.ASW_SHOT_DIR
  if (shotDir && win) {
    const target = win
    target.webContents.once('did-finish-load', async () => {
      const { captureAll, runScenario } = await import('./devshots.ts')
      if (process.env.ASW_SCENARIO) {
        const fs = await import('node:fs')
        await runScenario(target, shotDir, JSON.parse(fs.readFileSync(process.env.ASW_SCENARIO, 'utf8')))
      } else {
        const extra = process.env.ASW_SHOT_EXTRA ? (JSON.parse(process.env.ASW_SHOT_EXTRA) as { name: string; script: string }[]) : []
        await captureAll(target, shotDir, extra)
      }
      if (process.env.ASW_SHOT_QUIT) {
        quitting = true
        await proxy.stop()
        app.exit(0)
      }
    })
  }
})
