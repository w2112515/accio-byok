import { tr, tx } from '../../../shared/i18n.ts'
import { FolderOpen, Link2, Monitor, Moon, RotateCw, ShieldCheck, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AppSettings, NetworkProxyMode, UpdateInfo, DiagnosticPreview } from '../../../shared/types.ts'
import { validateUpstreamGateway } from '../../../shared/provider-input.ts'
import { PageHeader } from '../App.tsx'
import { AppLogo } from '../components/brand.tsx'
import { Badge, Button, Card, CardHeader, Input, Segmented, SettingRow, Sheet, Skeleton, StatusDot, Switch } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useStore } from '../lib/store.tsx'
import { fmtDateTime } from '../lib/format.ts'

function MaintenanceGroup() {
  const { state } = useStore()
  const [update, setUpdate] = useState<UpdateInfo>()
  const [download, setDownload] = useState<{ path: string; configBackup: string }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [preview, setPreview] = useState<DiagnosticPreview>()
  const [includeContent, setIncludeContent] = useState(false)
  const run = async (job: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await job() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  return <Group title={tx('Updates & diagnostics', '更新与诊断')}>
    <SettingRow title={tx('Accio compatibility', 'Accio 兼容性')} description={`${tx('Installed', '已安装')}: ${state?.accio.version ?? tx('Unknown', '未知')} · ${tx('Protocol baseline: 0.33 · reviewed 2026-10-01. Other versions need verification.', '协议验证基线：0.33 · 核对于 2026-10-01。其他版本仍需验证。')}`}>{null}</SettingRow>
    <SettingRow title={tx('Accio BYOK updates', 'Accio BYOK 更新')} description={update ? `${update.version}${update.prerelease ? ` · ${tx('Prerelease', '预发布')}` : ''} · ${update.newer ? tx('Update available', '有新版本') : tx('No newer version found', '未发现更高版本')} · ${fmtDateTime(update.checkedAt)}` : tx('Check the project’s GitHub releases when you choose.', '手动检查项目 GitHub 发布页。')}>
      <Button size="sm" disabled={busy} onClick={() => void run(async () => { setUpdate(await api.checkUpdate()) })}>{tx('Check updates', '检查更新')}</Button>
    </SettingRow>
    {update ? <div className="space-y-3 px-5 py-4">
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words text-[12px] text-muted">{update.notes || tx('No release notes.', '没有发布说明。')}</pre>
      <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void api.openExternal(update.pageUrl)}>{tx('Release page', '发布页面')}</Button>{update.newer ? update.assets.map((a) => <Button key={a.name} size="sm" disabled={busy || !a.sha256} onClick={() => void run(async () => { setDownload(await api.downloadUpdate(a.name)) })}>{a.name.includes('Setup') ? tx('Download installer', '下载安装包') : tx('Download portable', '下载便携版')}{!a.sha256 ? ` · ${tx('No checksum', '无校验值')}` : ''}</Button>) : null}</div>
      <p className="text-[12px] text-subtle">{tx('Downloads require the release’s SHA-256 checksum. Keep the previous executable; rollback requires its matching configuration and compatible Accio data. Credentials are stored separately and are never rolled back.', '下载须通过发布包 SHA-256 校验。请保留旧程序；回退需要对应配置及兼容的 Accio 数据，单独保存的授权凭据不参与回退。')}</p>
    </div> : null}
    {download ? <SettingRow title={tx('Verified download ready', '下载校验通过')} description={download.path}><Button size="sm" disabled={busy} onClick={() => void run(() => api.installUpdate())}>{tx('Open update', '打开更新')}</Button><Button size="sm" onClick={() => void api.openPath(state!.dataDir + '/updates')}>{tx('Backups & downloads', '备份与下载')}</Button></SettingRow> : null}
    <SettingRow title={tx('Include captured conversations', '包含已捕获会话')} description={tx('Optional: up to three recent captures. Known credentials are masked, but private text may remain. Review the preview before saving.', '可选：最多三条近期捕获。会遮盖已知凭据，但正文可能仍含隐私，请在保存前逐项核对预览。')} htmlFor="diagnostic-content"><Switch id="diagnostic-content" checked={includeContent} onCheckedChange={(v) => { setIncludeContent(v); setPreview(undefined) }} /></SettingRow>
    <SettingRow title={tx('Diagnostic export', '诊断导出')} description={tx('Default: status, timings and usage only. No keys, endpoints, account names or conversation text. Nothing is uploaded.', '默认仅含状态、耗时和用量，不含密钥、地址、账号名称和会话正文，不会上传。')}><Button size="sm" disabled={busy} onClick={() => void run(async () => { setPreview(await api.diagnosticPreview(includeContent)) })}>{tx('Preview report', '预览报告')}</Button></SettingRow>
    {error ? <p role="alert" className="px-5 py-3 text-[12px] text-danger">{error}</p> : null}
    <SettingRow title={tx('Restore configuration backup', '恢复配置备份')} description={tx('For rollback to the version that created the backup. Close Accio first; OAuth tokens are not restored.', '用于回退到生成该备份的版本，需先关闭 Accio；不恢复 OAuth 令牌。')}><Button size="sm" disabled={busy} onClick={() => void run(() => api.restoreConfigBackup())}>{tx('Choose backup', '选择备份')}</Button></SettingRow>
    <Sheet open={!!preview} onOpenChange={(v) => { if (!v) setPreview(undefined) }} title={tx('Review diagnostic export', '审阅诊断导出')}>
      <Button className="mb-4" disabled={busy} onClick={() => void run(async () => { const saved = await api.exportDiagnostic(preview!.id); if (saved) { toast.success(tx('Diagnostic saved', '诊断已保存')); setPreview(undefined) } })}>{tx('Save reviewed report', '保存已审阅报告')}</Button>
      {preview?.includesContent ? <p className="mb-3 text-[12px] text-warning">{tx('Contains conversation content. Check for personal information and secrets before sharing.', '包含会话内容，请在分享前检查个人信息及隐私凭据。')}</p> : null}
      <pre className="whitespace-pre-wrap break-all font-mono text-[11px]" data-selectable>{preview?.content}</pre>
    </Sheet>
  </Group>
}

function SavedAccounts() {
  const { state } = useStore()
  const [busy, setBusy] = useState<string>()
  const run = async (id: string, disconnect: boolean) => {
    setBusy(id)
    try {
      if (disconnect) {
        const result = await api.signOut(id)
        toast.success(tx('Signed out locally', '已退出本地授权'), { description: result.remoteRevoked ? tx('The refresh token was revoked remotely.', '已在远端撤销刷新令牌。') : tx('Remote revocation is unconfirmed. Remove this app/key in the provider’s settings if needed.', '未确认远端撤销，必要时请在供应商设置删除本应用授权或 Key。') })
      } else await api.resumeAuthorization(id)
    } catch (e) { toast.error((e as Error).message) } finally { setBusy(undefined) }
  }
  if (!state?.authorizations?.length && !state?.authorizationError) return null
  return <Group title={tx('Saved authorizations', '已保存授权')} description={tx('Connections reference these local encrypted registrations. Signing out does not delete your connection profiles.', '连接引用这些本地加密授权，退出不会删除连接配置。')}>
    {state.authorizationError ? <p role="alert" className="p-4 text-[12px] text-danger">{state.authorizationError}</p> : null}
    {state.authorizations?.map((a) => <SettingRow key={a.id} title={a.label} description={a.pauseReason || (a.connected ? tx('Connected', '已连接') : tx('Signed out', '已退出'))}>
      {a.pauseReason && a.connected ? <Button size="sm" disabled={!!busy} onClick={() => void run(a.id, false)}>{tx('Resume after usage review', '核对用量后恢复')}</Button> : null}
      <Button size="sm" onClick={() => void api.openExternal(a.service === 'openai' ? 'https://chatgpt.com/settings/usage' : 'https://openrouter.ai/keys')}>{tx('Manage usage', '管理用量')}</Button>
      <Button size="sm" disabled={!!busy || !a.connected} onClick={() => void run(a.id, true)}>{tx('Sign out', '退出授权')}</Button>
    </SettingRow>)}
  </Group>
}

function Group({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <div className="mt-2 divide-y divide-border pb-1">{children}</div>
    </Card>
  )
}

export function SettingsPage() {
  const { state } = useStore()
  const [port, setPort] = useState('')
  const [gateway, setGateway] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [networkMode, setNetworkMode] = useState<NetworkProxyMode>('system')
  const [idleSeconds, setIdleSeconds] = useState('180')
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!state) return
    setPort(String(state.settings.proxyPort))
    setGateway(state.settings.upstreamGateway)
    setProxyUrl(state.settings.networkProxyUrl)
    setNetworkMode(state.settings.networkProxy)
    setIdleSeconds(String(state.settings.upstreamIdleTimeoutSeconds ?? 180))
  }, [state?.settings.proxyPort, state?.settings.upstreamGateway, state?.settings.networkProxyUrl, state?.settings.networkProxy, state?.settings.upstreamIdleTimeoutSeconds]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) return <Skeleton className="h-96 w-full rounded-2xl" />
  const s = state.settings
  let gatewayError: string | undefined
  try { validateUpstreamGateway(s.upstreamGateway) } catch (e) { gatewayError = (e as Error).message }
  const update = async (patch: Partial<AppSettings>, msg?: string) => {
    setError(undefined)
    try {
      await api.updateSettings(patch)
      if (msg) toast.success(msg)
    } catch (e) {
      setError((e as Error).message)
      toast.error(tr("保存失败"), { description: (e as Error).message })
    }
  }

  return (
    <>
      <PageHeader title={tr("设置")} />
      {gatewayError ? <p role="alert" className="mb-4 rounded-lg bg-danger-soft p-3 text-[13px] text-danger">{tr("当前上游网关已被阻止转发，请修改下方网关地址。")}{gatewayError}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-lg bg-danger-soft p-3 text-[13px] text-danger">{error}</p> : null}
      <fieldset disabled={!!state.busyOperation || !!state.configError} className="min-w-0 space-y-6">
        <Group title="Accio" description={tr("Accio BYOK 通过环境变量启动 Accio，不会修改 Accio 的任何文件。")}>
          <SettingRow title={tr("程序位置")} description={<span className="font-mono text-[12px]">{state.accio.exePath || tr("未找到")}</span>}>
            <Button
              size="sm"
              onClick={async () => {
                try { const p = await api.browseAccioExe(); if (p) toast.success(tr("已更新 Accio 位置")) }
                catch (e) { setError((e as Error).message) }
              }}
            >
              <FolderOpen />
              {tr("选择…")}</Button>
          </SettingRow>
          <SettingRow title={tr("桌面快捷方式")} description={tr("创建「Accio (BYOK)」快捷方式，双击即通过 Accio BYOK 启动 Accio。")}>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await api.createDesktopShortcut()
                  toast.success(tr("已在桌面创建快捷方式"))
                } catch (e) {
                  toast.error(tr("创建失败"), { description: (e as Error).message })
                }
              }}
            >
              <Link2 />
              {tr("创建")}</Button>
          </SettingRow>
          <SettingRow title={tr("启动 Accio BYOK 时自动启动 Accio")} htmlFor="st-autolaunch">
            <Switch id="st-autolaunch" checked={s.launchAccioOnStart} onCheckedChange={(v) => update({ launchAccioOnStart: v })} />
          </SettingRow>
        </Group>

        <Group title={tr("本地代理")} description={tr("Accio 的网关请求会发到这个地址。模型请求按当前供应商处理，其他请求原样转发。")}>
          <SettingRow
            title={tr("状态")}
            description={
              <span className="inline-flex items-center gap-1.5">
                <StatusDot tone={state.proxy.running ? 'success' : 'danger'} />
                {state.proxy.running ? <span className="font-mono">{state.proxy.url}</span> : (state.proxy.error ?? tr("已停止"))}
              </span>
            }
          >
            <Button
              size="sm"
              onClick={async () => {
                setError(undefined)
                try {
                  const result = await api.restartProxy()
                  if (!result.running) throw new Error(result.error ?? tr("代理未能启动"))
                  toast.success(tr("代理已启动 · 端口 {0}", result.port))
                } catch (e) { setError((e as Error).message) }
              }}
            >
              <RotateCw />
              {tr("重启")}</Button>
          </SettingRow>
          <SettingRow title={tr("首选端口")} description={tr("启动时被占用可选备用端口；之后重启保持实际端口。修改前请关闭 Accio。")} htmlFor="st-port">
            <Input id="st-port" value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))} className="h-8 w-24 text-center tabular" />
            <Button size="sm" disabled={Number(port) === s.proxyPort || Number(port) < 1024 || Number(port) > 65535} onClick={() => update({ proxyPort: Number(port) }, tr("端口已更新"))}>
              {tr("应用")}</Button>
          </SettingRow>
          <SettingRow title={tr("上游网关")} description={tr("接收 Accio 登录凭据、插件与同步数据。默认从 Accio 日志识别；仅填写可信的官方网关，远程地址必须为 HTTPS。")} htmlFor="st-gw">
            <Input id="st-gw" value={gateway} onChange={(e) => setGateway(e.target.value)} className="h-8 w-72 font-mono text-[12px]" spellCheck={false} />
            <Button size="sm" disabled={gateway === s.upstreamGateway || !/^https?:\/\//.test(gateway)} onClick={() => update({ upstreamGateway: gateway.replace(/\/+$/, '') }, tr("上游网关已更新"))}>
              {tr("应用")}</Button>
          </SettingRow>
        </Group>

        <Group title={tr("网络")} description={tr("访问模型供应商时使用的出站方式。国内访问 OpenAI、Claude、Gemini 通常需要代理。")}>
          <SettingRow title={tr("出站代理")}>
            <Segmented<NetworkProxyMode>
              label={tr("出站代理")}
              value={networkMode}
              onChange={setNetworkMode}
              options={[
                { value: 'system', label: tr("跟随系统") },
                { value: 'direct', label: tr("直连") },
                { value: 'custom', label: tr("自定义") },
              ]}
            />
          </SettingRow>
          {networkMode === 'custom' ? (
            <SettingRow title={tr("代理地址")} description={tr("支持 http://、socks5:// 等，例如 http://127.0.0.1:7890")} htmlFor="st-proxy">
              <Input id="st-proxy" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="http://127.0.0.1:7890" className="h-8 w-64 font-mono text-[12px]" spellCheck={false} />
            </SettingRow>
          ) : null}
          <SettingRow title={tr("应用网络设置")} description={tr("模式与地址一起保存。存在进行中的请求时，会要求等待完成。")}>
            <Button size="sm" disabled={(networkMode === s.networkProxy && proxyUrl.trim() === s.networkProxyUrl) || (networkMode === 'custom' && !proxyUrl.trim())} onClick={() => update({ networkProxy: networkMode, networkProxyUrl: proxyUrl.trim() }, tr("网络设置已应用"))}>{tr("应用")}</Button>
          </SettingRow>
          <SettingRow title={tr("无进展等待时间")} description={tr("模型持续无新事件时停止等待，默认 180 秒；连接等待上限为 60 秒。慢推理模型可适当调高。")} htmlFor="st-idle">
            <Input id="st-idle" value={idleSeconds} onChange={(e) => setIdleSeconds(e.target.value.replace(/[^\d]/g, ''))} className="h-8 w-24 tabular" />
            <span className="text-[12px] text-muted">{tr("秒")}</span>
            <Button size="sm" disabled={Number(idleSeconds) === (s.upstreamIdleTimeoutSeconds ?? 180) || Number(idleSeconds) < 30 || Number(idleSeconds) > 3600} onClick={() => update({ upstreamIdleTimeoutSeconds: Number(idleSeconds) }, tr("等待时间已更新"))}>{tr("应用")}</Button>
          </SettingRow>
        </Group>

        <Group title={tr("行为")}>
          <SettingRow title={tr('语言')} description={tr('默认使用英文，可随时切换为简体中文。选择会在下次启动时保留。')}>
            <Segmented
              label="Language / 语言"
              value={s.language ?? 'en'}
              onChange={(language: 'en' | 'zh-CN') => update({ language })}
              options={[{ value: 'en', label: 'English' }, { value: 'zh-CN', label: '简体中文' }]}
            />
          </SettingRow>
          <SettingRow title={tr("关闭窗口时最小化到托盘")} description={tr("代理需要保持运行，Accio 才能联网。")} htmlFor="st-tray">
            <Switch id="st-tray" checked={s.minimizeToTray} onCheckedChange={(v) => update({ minimizeToTray: v })} />
          </SettingRow>
          <SettingRow title={tr("开机自动启动")} description={tr("登录 Windows 后在托盘中静默运行。")} htmlFor="st-login">
            <Switch id="st-login" checked={s.openAtLogin} onCheckedChange={(v) => update({ openAtLogin: v })} />
          </SettingRow>
          <SettingRow title={tr("外观")}>
            <Segmented
              label={tr("外观")}
              value={s.theme}
              onChange={(v) => update({ theme: v })}
              options={[
                { value: 'system', label: <span className="inline-flex items-center gap-1.5"><Monitor className="size-3.5" />{tr("系统")}</span> },
                { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Sun className="size-3.5" />{tr("浅色")}</span> },
                { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Moon className="size-3.5" />{tr("深色")}</span> },
              ]}
            />
          </SettingRow>
        </Group>

        <SavedAccounts />
        <MaintenanceGroup />
        <Group title={tr("隐私与调试")}>
          <SettingRow title={tr("API Key 加密")} description={tr("使用 Windows 数据保护 API（DPAPI）加密，只有当前 Windows 用户能解密。")}>
            {state.encryptionAvailable ? (
              <Badge tone="success">
                <ShieldCheck />
                {tr("已启用")}</Badge>
            ) : (
              <Badge tone="warning">{tr("不可用")}</Badge>
            )}
          </SettingRow>
          <SettingRow title={tr("捕获请求内容")} description={tr("仅在内存保留最近 30 次请求，单条最多 2 MiB、合计 16 MiB；超限会注明省略。关闭或重启后清除，不写入磁盘。")} htmlFor="st-debug">
            <Switch id="st-debug" checked={s.debugCapture} onCheckedChange={(v) => update({ debugCapture: v })} />
          </SettingRow>
          <SettingRow title={tr("数据目录")} description={<span className="font-mono text-[12px]">{state.dataDir}</span>}>
            <Button size="sm" onClick={() => void api.openPath(state.dataDir)}>
              <FolderOpen />
              {tr("打开")}</Button>
          </SettingRow>
        </Group>

        <Card className="flex items-center gap-4 p-5">
          <AppLogo className="size-11" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">Accio BYOK {state.version}</div>
            <div className="text-[12.5px] leading-relaxed text-muted">{tr("为 Accio 带来自有模型 Key、热切换、用量统计与会话备份。社区工具，与阿里巴巴或 Accio 官方无关。")}</div>
          </div>
        </Card>
      </fieldset>
    </>
  )
}
