import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, session, shell, Tray } from 'electron'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import iconPath from '../../resources/icon.png?asset'
import trayIconPath from '../../resources/tray.png?asset'
import type { AccioSwitchApi, AppState } from '../shared/api.ts'
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
  stopAccio,
} from './accio.ts'
import { ConfigStore, validateSettings, type SecretBox } from './config.ts'
import { LogStore } from './logs.ts'
import { parseAccioRequest } from './proxy/accio.ts'
import { ADAPTERS, streamByok } from './proxy/byok.ts'
import { ModelListCache } from './model-list.ts'
import { protectedFetch, redactProviderError } from './proxy/request-policy.ts'
import { ProxyServer } from './proxy/server.ts'
import { SessionManager } from './sessions.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

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
const modelLists = new ModelListCache()

const box: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (s) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用，未保存 API Key；请恢复系统加密服务后重试')
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
  if (proxy.activeRequests) throw new Error('仍有请求进行中，请等待完成后再重启代理')
  const boundPort = proxy.status.port
  const st = await proxy.start(boundPort || config.settings.proxyPort, !boundPort)
  lastAccioSeen = 0
  broadcast({ type: 'status' })
  if (!st.running) throw new Error(`本地代理未能启动：${st.error ?? '端口不可用'}`)
  return st
}

async function runOperation<T>(name: string, action: () => Promise<T> | T): Promise<T> {
  if (busyOperation) throw new Error(`正在${busyOperation}，请等待完成后重试`)
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
  return runOperation('启动 Accio', async () => {
  config.assertWritable()
  config.resolveTarget()
  accioOperation = 'starting'
  accioError = undefined
  try {
  const exe = resolveExe()
  if (!exe) throw new Error('没有找到 Accio，请在「设置」中指定 Accio.exe 的位置')
  if (!proxy.status.running) await startProxy()
  if (!proxy.status.running) throw new Error(`本地代理未能启动：${proxy.status.error ?? ''}`)
  await stopAccio()
  launchedPid = undefined
  lastAccioSeen = 0
  launchStartedAt = Date.now()
  await launchAccio(exe, proxy.status.url)
  // The spawned process is a launcher stub for some installs; remember whatever runs next.
  await new Promise((r) => setTimeout(r, 2500))
  const pids = await listAccioPids()
  if (!pids.length) throw new Error('Accio 启动后未检测到运行进程，请检查程序位置或手动启动查看错误')
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
  return runOperation('恢复官方直连', async () => {
  accioOperation = 'direct'
  accioError = undefined
  try {
  const exe = resolveExe()
  if (!exe) throw new Error('没有找到 Accio')
  await stopAccio()
  launchedPid = undefined
  lastAccioSeen = 0
  launchStartedAt = undefined
  await launchAccio(exe)
  await new Promise((r) => setTimeout(r, 1500))
  if (!(await listAccioPids()).length) throw new Error('未检测到直连启动的 Accio，代理已保留，请重试或手动启动 Accio')
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
    title: `${providerName} 请求失败`,
    body: `${error.replace(/^\[Accio (?:Switch|BYOK)\]\s*/, '').slice(0, 140)}\n点击查看详情，或在托盘中切换来源。`,
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

async function testProvider(input: ProviderInput, scope: TestScope = 'text'): Promise<TestResult> {
  if (busyOperation) throw new Error(`正在${busyOperation}，请稍后测试`)
  if (!['text', 'tools', 'image'].includes(scope)) throw new Error('未知的检测类型')
  const provider = { ...config.draft(input), maxOutputTokens: 1024, thinking: 'off' as const, sendReasoningEffort: false }
  networkTests++
  try {
  const started = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  let out = ''
  // Synthetic fixtures only: no user conversation, files, or executable tools.
  const prompt = scope === 'tools' ? 'Call the connection_probe tool with value "pong". Do not answer with text.' : scope === 'image' ? 'What is the dominant color of this image? Reply with one English color word.' : 'Reply with the single word: pong'
  const redSquare = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg=='
  const result = await streamByok({
    req: parseAccioRequest({ model: 'test', max_output_tokens: 1024, include_thoughts: false,
      tools: scope === 'tools' ? [{ name: 'connection_probe', description: 'A harmless connection check. Returns nothing and performs no action.', parameters_json: JSON.stringify({ type: 'object', properties: { value: { type: 'string', enum: ['pong'] } }, required: ['value'], additionalProperties: false }) }] : [],
      contents: [{ role: 'user', parts: [{ text: prompt }, ...(scope === 'image' ? [{ inline_data: { mime_type: 'image/png', data: redSquare } }] : [])] }] }),
    provider,
    model: provider.model,
    fetch: netFetch,
    signal: ctrl.signal,
    write: (c) => (out += c),
  })
  clearTimeout(timer)
  let text = ''
  let validCall = false
  for (const block of out.split('\n\n')) {
    if (!block.startsWith('data: ') || block.includes('[DONE]')) continue
    try {
      const f = JSON.parse(block.slice(6))
      for (const p of f.content?.parts ?? []) {
        if (typeof p.text === 'string' && !p.thought) text += p.text
        if (f.turnComplete && p.functionCall?.name === 'connection_probe') {
          const args = JSON.parse(p.functionCall.argsJson)
          validCall ||= args.value === 'pong' && Object.keys(args).length === 1
        }
      }
    } catch {
      /* ignore */
    }
  }
  const stamp = { scope, checkedAt: Date.now(), notSent: result.notSent, protection: netFetch.inspect(provider.baseUrl, { headers: ADAPTERS[provider.kind].headers(provider) }) }
  if (result.status === 'aborted') return { ...stamp, ok: false, latencyMs: Date.now() - started, model: provider.model, message: '请求超时（60 秒）；供应商可能已计费' }
  const passed = scope === 'tools' ? validCall : scope === 'image' ? /\bred\b/i.test(text) : !!text.trim()
  return {
    ...stamp,
    ok: result.status === 'ok' && passed,
    latencyMs: result.ttftMs ?? Date.now() - started,
    model: provider.model,
    message: result.status !== 'ok' ? (result.error ?? '未知错误') : scope === 'tools' ? validCall ? '收到名称和参数正确的工具调用；未执行工具。多轮工具任务仍需在 Accio 验证。' : '未收到预期的工具调用，本次检测未通过。' : scope === 'image' ? passed ? '正确识别测试图片的红色。复杂图像仍需单独验证。' : `未识别出测试图片颜色，本次检测未通过。返回：${text.slice(0, 100)}` : text.trim().slice(0, 160) || '未返回可见文本，本次检测未通过。',
  }
  } finally { networkTests-- }
}

// ---------------------------------------------------------------------------
// IPC

function state(): AppState {
  return {
    version: app.getVersion(),
    providers: config.providerViews().map((view) => {
      if (view.keyError || !netFetch) return view
      try {
        const p = config.provider(view.id)!
        return { ...view, protection: netFetch.inspect(p.baseUrl, { headers: ADAPTERS[p.kind].headers(p) }) }
      } catch { return view }
    }),
    activeProviderId: config.activeProviderId,
    settings: config.settings,
    proxy: proxy.status,
    accio: accioState,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    dataDir: app.getPath('userData'),
    configError: config.loadError,
    operationError,
    busyOperation,
  }
}

const api: AccioSwitchApi = {
  getState: async () => state(),
  saveProvider: (input, activate) => runOperation('保存供应商', () => config.saveProvider(input, activate)),
  recoverConfig: (action) => runOperation('恢复配置', async () => {
    config.recover(action)
    await applyNetworkProxy()
    await startProxy()
    nativeTheme.themeSource = config.settings.theme
    await refreshAccio()
  }),
  deleteProvider: (id) => runOperation('删除供应商', () => config.deleteProvider(id)),
  duplicateProvider: (id) => runOperation('复制供应商', () => config.duplicateProvider(id)),
  activateProvider: (id) => runOperation('切换供应商', () => config.setActive(id)),
  reorderProviders: (ids) => runOperation('调整供应商顺序', () => config.reorder(ids)),
  testProvider,
  listProviderModels: async (input, refresh) => {
    if (busyOperation) throw new Error(`正在${busyOperation}，请稍后读取模型列表`)
    const p = config.draft(input)
    networkTests++
    try { return await modelLists.list(p, netFetch, refresh) } catch (e) { throw new Error(redactProviderError(e instanceof Error ? e.message : String(e), p)) } finally { networkTests-- }
  },
  providerModelInfo: async (input) => {
    if (busyOperation) throw new Error(`正在${busyOperation}，请稍后读取模型信息`)
    const p = config.draft(input)
    if (!p.model) throw new Error('请先选择模型')
    networkTests++
    try { return await modelLists.describe(p, netFetch) } catch (e) { throw new Error(redactProviderError(e instanceof Error ? e.message : String(e), p)) } finally { networkTests-- }
  },
  updateSettings: (patch) => runOperation('应用设置', async () => {
    config.assertWritable()
    const prev = config.settings
    const next = validateSettings({ ...prev, ...patch })
    const networkChanged = next.networkProxy !== prev.networkProxy || next.networkProxyUrl !== prev.networkProxyUrl
    const portChanged = next.proxyPort !== prev.proxyPort
    if (portChanged && (await refreshAccio()).running) throw new Error('请先关闭 Accio，再修改本地代理端口')
    if ((networkChanged || portChanged || next.upstreamGateway !== prev.upstreamGateway) && (proxy.activeRequests || networkTests)) throw new Error('仍有请求或测试进行中，请等待完成后再修改网络设置')
    const oldPort = proxy.status.port
    networkChanging = networkChanged
    try {
      if (networkChanged) await applyNetworkProxy(next)
      if (portChanged) {
        const st = await proxy.start(next.proxyPort, true)
        if (!st.running) throw new Error(`新端口未能启动：${st.error}`)
        lastAccioSeen = 0
      }
      if (patch.openAtLogin !== undefined && app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.openAtLogin, args: ['--hidden'] })
      config.updateSettings(next)
    } catch (e) {
      const rollbackErrors: string[] = []
      if (networkChanged) await applyNetworkProxy(prev).catch((err) => rollbackErrors.push(`出站代理恢复失败：${String(err)}`))
      if (portChanged) {
        const restored = await proxy.start(oldPort || prev.proxyPort, !oldPort)
        if (!restored.running) rollbackErrors.push(`本地端口恢复失败：${restored.error}`)
      }
      if (patch.openAtLogin !== undefined && app.isPackaged) {
        try { app.setLoginItemSettings({ openAtLogin: prev.openAtLogin, args: ['--hidden'] }) } catch (err) { rollbackErrors.push(`自启恢复失败：${String(err)}`) }
      }
      throw new Error(`${e instanceof Error ? e.message : String(e)}${rollbackErrors.length ? `；${rollbackErrors.join('；')}` : '；原配置已保留'}`)
    } finally { networkChanging = false }
    if (patch.debugCapture === false) logs.clearCaptures()
    if (patch.theme) nativeTheme.themeSource = next.theme
    return next
  }),
  restartProxy: () => runOperation('重启代理', startProxy),
  accioTakeover: takeoverAccio,
  accioStop: () => runOperation('关闭 Accio', async () => {
    await stopAccio()
    launchedPid = undefined
    lastAccioSeen = 0
    return refreshAccio()
  }),
  accioLaunchDirect: launchDirect,
  accioModels: async () => readModelCatalog(),
  browseAccioExe: async () => {
    const r = await dialog.showOpenDialog(win!, { title: '选择 Accio.exe', filters: [{ name: 'Accio', extensions: ['exe'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return undefined
    await runOperation('更新 Accio 位置', () => config.updateSettings({ accioExePath: r.filePaths[0] }))
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
      description: '通过 Accio BYOK 启动 Accio（使用你自己的模型 Key）',
      appUserModelId: 'app.accio-switch',
    })
    if (!ok) throw new Error('创建快捷方式失败')
    return target
  },
  recentLogs: async (limit) => logs.recent(limit),
  usageStats: (days) => logs.stats(days),
  logCapture: async (id) => logs.capture(id),
  clearLogs: () => logs.clear(),
  listAccounts: () => sessions.listAccounts(),
  listBackups: () => sessions.listBackups(),
  createBackup: (accountId, note) => runOperation('备份会话', () => sessions.backup(accountId, 'manual', note)),
  restoreBackup: (id) => runOperation('恢复会话', async () => {
    if ((await listAccioPids()).length) throw new Error('请先关闭 Accio 再恢复备份')
    return sessions.restore(id)
  }),
  migrateBackup: (id, target) => runOperation('迁移会话', async () => {
    if ((await listAccioPids()).length) throw new Error('请先关闭 Accio 再迁移会话')
    return sessions.migrate(id, target)
  }),
  deleteBackup: (id) => runOperation('删除备份', () => sessions.deleteBackup(id)),
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
      new Notification({ title: 'Accio BYOK 仍在后台运行', body: '本地代理需要保持运行，Accio 才能使用你的模型。右键托盘图标可以快速切换或退出。', icon: iconPath }).show()
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
  const activeName = active === OFFICIAL_PROVIDER_ID ? 'Accio 官方' : (providers.find((p) => p.id === active)?.name ?? 'Accio 官方')
  const choose = (id: string) => void api.activateProvider(id).catch((e) => dialog.showErrorBox('无法切换供应商', String(e?.message ?? e)))
  tray.setToolTip(`Accio BYOK · ${activeName}${accioState.takenOver ? ' · 代理已收到请求' : ''}`)
  const menu = Menu.buildFromTemplate([
    { label: `当前：${activeName}`, enabled: false },
    { type: 'separator' },
    { label: 'Accio 官方模型', type: 'radio', checked: active === OFFICIAL_PROVIDER_ID, enabled: !busyOperation && !config.loadError, click: () => choose(OFFICIAL_PROVIDER_ID) },
    ...providers.map((p) => ({
      label: `${p.name}${p.model ? `  ·  ${p.model}` : ''}`,
      type: 'radio' as const,
      checked: active === p.id,
      enabled: !busyOperation && !config.loadError,
      click: () => choose(p.id),
    })),
    { type: 'separator' },
    {
      label: accioState.takenOver ? '重启 Accio' : accioState.running ? '接管 Accio（重启）' : '启动 Accio',
      enabled: Boolean(accioState.installed) && !busyOperation && !config.loadError,
      click: () => confirmNativeLaunch().catch((e) => dialog.showErrorBox('Accio BYOK', String(e?.message ?? e))),
    },
    { label: '打开 Accio BYOK', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => void quitApp().catch((e) => dialog.showErrorBox('未能退出，代理已保留', String(e?.message ?? e))) },
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
    dialog.showErrorBox('操作进行中', `正在${busyOperation}，请完成后再退出`)
    return
  }
  const st = await refreshAccio()
  if (st.running && (st.takenOver || st.launchedByUs)) {
    const parent = win && win.isVisible() ? win : undefined
    const opts = {
      type: 'warning' as const,
      buttons: ['退出，并让 Accio 恢复官方直连', '仍然退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Accio BYOK',
      message: 'Accio 正在通过 Accio BYOK 联网',
      detail: '退出后本地代理会停止，正在运行的 Accio 将无法连接网络。可以让 Accio 以官方直连方式自动重启。',
    }
    const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
    if (r.response === 2) return
    if (r.response === 0) {
      try { await launchDirect() } catch (e) {
        dialog.showErrorBox('未能恢复官方直连，代理已保留', e instanceof Error ? e.message : String(e))
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
    const choice = await dialog.showMessageBox({ type: 'warning', title: '重启 Accio？', message: '接入会重启正在运行的 Accio', detail: '正在生成的回复和运行中的任务会被中断，请先保存当前工作。', buttons: ['重启并接入', '取消'], defaultId: 1, cancelId: 1, noLink: true })
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
  nativeTheme.themeSource = config.settings.theme
  logs = new LogStore(path.join(userData, 'logs'))
  sessions = new SessionManager({
    accioDir: ACCIO_DIR,
    backupDir: path.join(userData, 'backups'),
    rememberedAccountsFile: path.join(ACCIO_APPDATA, 'remembered-accounts.json'),
    beforeWrite: async () => {
      if ((await listAccioPids()).length) throw new Error('检测到 Accio 重新启动，已停止会话写入。请关闭 Accio 后重试。')
    },
  })
  const netSession = session.fromPartition('persist:accio-switch-net')
  netFetch = protectedFetch((url, init) => {
    if (networkChanging) throw new Error('网络设置正在应用，请稍后重试')
    return netSession.fetch(url, init as RequestInit)
  }, Date.now, () => broadcast({ type: 'status' }))
  try { await applyNetworkProxy() } catch (e) { operationError = `出站网络设置未能应用：${e instanceof Error ? e.message : String(e)}` }

  proxy = new ProxyServer({
    resolveTarget: () => config.resolveTarget(),
    upstream: () => config.settings.upstreamGateway,
    fetch: (url, init) => netFetch(url, init),
    onLog: (entry, capture, pricing) => {
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

  createTray()
  const hidden = process.argv.includes('--hidden') || process.argv.includes('--launch-accio')
  createWindow(!hidden)
  handleArgs(process.argv)
  if (config.settings.launchAccioOnStart && !accioState.running && !config.loadError) takeoverAccio().catch((e) => dialog.showErrorBox('Accio 启动失败', String(e?.message ?? e)))

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
