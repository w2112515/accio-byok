import { FolderOpen, Link2, Monitor, Moon, RotateCw, ShieldCheck, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { AppSettings, NetworkProxyMode } from '../../../shared/types.ts'
import { validateUpstreamGateway } from '../../../shared/provider-input.ts'
import { PageHeader } from '../App.tsx'
import { AppLogo } from '../components/brand.tsx'
import { Badge, Button, Card, CardHeader, Input, Segmented, SettingRow, Skeleton, StatusDot, Switch } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { useStore } from '../lib/store.tsx'

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
      toast.error('保存失败', { description: (e as Error).message })
    }
  }

  return (
    <>
      <PageHeader title="设置" />
      {gatewayError ? <p role="alert" className="mb-4 rounded-lg bg-danger-soft p-3 text-[13px] text-danger">当前上游网关已被阻止转发，请修改下方网关地址。{gatewayError}</p> : null}
      {error ? <p role="alert" className="mb-4 rounded-lg bg-danger-soft p-3 text-[13px] text-danger">{error}</p> : null}
      <fieldset disabled={!!state.busyOperation || !!state.configError} className="min-w-0 space-y-6">
        <Group title="Accio" description="Accio BYOK 通过环境变量启动 Accio，不会修改 Accio 的任何文件。">
          <SettingRow title="程序位置" description={<span className="font-mono text-[12px]">{state.accio.exePath || '未找到'}</span>}>
            <Button
              size="sm"
              onClick={async () => {
                try { const p = await api.browseAccioExe(); if (p) toast.success('已更新 Accio 位置') }
                catch (e) { setError((e as Error).message) }
              }}
            >
              <FolderOpen />
              选择…
            </Button>
          </SettingRow>
          <SettingRow title="桌面快捷方式" description="创建「Accio (BYOK)」快捷方式，双击即通过 Accio BYOK 启动 Accio。">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await api.createDesktopShortcut()
                  toast.success('已在桌面创建快捷方式')
                } catch (e) {
                  toast.error('创建失败', { description: (e as Error).message })
                }
              }}
            >
              <Link2 />
              创建
            </Button>
          </SettingRow>
          <SettingRow title="启动 Accio BYOK 时自动启动 Accio" htmlFor="st-autolaunch">
            <Switch id="st-autolaunch" checked={s.launchAccioOnStart} onCheckedChange={(v) => update({ launchAccioOnStart: v })} />
          </SettingRow>
        </Group>

        <Group title="本地代理" description="Accio 的网关请求会发到这个地址。模型请求按当前供应商处理，其他请求原样转发。">
          <SettingRow
            title="状态"
            description={
              <span className="inline-flex items-center gap-1.5">
                <StatusDot tone={state.proxy.running ? 'success' : 'danger'} />
                {state.proxy.running ? <span className="font-mono">{state.proxy.url}</span> : (state.proxy.error ?? '已停止')}
              </span>
            }
          >
            <Button
              size="sm"
              onClick={async () => {
                setError(undefined)
                try {
                  const result = await api.restartProxy()
                  if (!result.running) throw new Error(result.error ?? '代理未能启动')
                  toast.success(`代理已启动 · 端口 ${result.port}`)
                } catch (e) { setError((e as Error).message) }
              }}
            >
              <RotateCw />
              重启
            </Button>
          </SettingRow>
          <SettingRow title="首选端口" description="启动时被占用可选备用端口；之后重启保持实际端口。修改前请关闭 Accio。" htmlFor="st-port">
            <Input id="st-port" value={port} onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))} className="h-8 w-24 text-center tabular" />
            <Button size="sm" disabled={Number(port) === s.proxyPort || Number(port) < 1024 || Number(port) > 65535} onClick={() => update({ proxyPort: Number(port) }, '端口已更新')}>
              应用
            </Button>
          </SettingRow>
          <SettingRow title="上游网关" description="接收 Accio 登录凭据、插件与同步数据。默认从 Accio 日志识别；仅填写可信的官方网关，远程地址必须为 HTTPS。" htmlFor="st-gw">
            <Input id="st-gw" value={gateway} onChange={(e) => setGateway(e.target.value)} className="h-8 w-72 font-mono text-[12px]" spellCheck={false} />
            <Button size="sm" disabled={gateway === s.upstreamGateway || !/^https?:\/\//.test(gateway)} onClick={() => update({ upstreamGateway: gateway.replace(/\/+$/, '') }, '上游网关已更新')}>
              应用
            </Button>
          </SettingRow>
        </Group>

        <Group title="网络" description="访问模型供应商时使用的出站方式。国内访问 OpenAI、Claude、Gemini 通常需要代理。">
          <SettingRow title="出站代理">
            <Segmented<NetworkProxyMode>
              label="出站代理"
              value={networkMode}
              onChange={setNetworkMode}
              options={[
                { value: 'system', label: '跟随系统' },
                { value: 'direct', label: '直连' },
                { value: 'custom', label: '自定义' },
              ]}
            />
          </SettingRow>
          {networkMode === 'custom' ? (
            <SettingRow title="代理地址" description="支持 http://、socks5:// 等，例如 http://127.0.0.1:7890" htmlFor="st-proxy">
              <Input id="st-proxy" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="http://127.0.0.1:7890" className="h-8 w-64 font-mono text-[12px]" spellCheck={false} />
            </SettingRow>
          ) : null}
          <SettingRow title="应用网络设置" description="模式与地址一起保存。存在进行中的请求时，会要求等待完成。">
            <Button size="sm" disabled={(networkMode === s.networkProxy && proxyUrl.trim() === s.networkProxyUrl) || (networkMode === 'custom' && !proxyUrl.trim())} onClick={() => update({ networkProxy: networkMode, networkProxyUrl: proxyUrl.trim() }, '网络设置已应用')}>应用</Button>
          </SettingRow>
          <SettingRow title="无进展等待时间" description="模型持续无新事件时停止等待，默认 180 秒；连接等待上限为 60 秒。慢推理模型可适当调高。" htmlFor="st-idle">
            <Input id="st-idle" value={idleSeconds} onChange={(e) => setIdleSeconds(e.target.value.replace(/[^\d]/g, ''))} className="h-8 w-24 tabular" />
            <span className="text-[12px] text-muted">秒</span>
            <Button size="sm" disabled={Number(idleSeconds) === (s.upstreamIdleTimeoutSeconds ?? 180) || Number(idleSeconds) < 30 || Number(idleSeconds) > 3600} onClick={() => update({ upstreamIdleTimeoutSeconds: Number(idleSeconds) }, '等待时间已更新')}>应用</Button>
          </SettingRow>
        </Group>

        <Group title="行为">
          <SettingRow title="关闭窗口时最小化到托盘" description="代理需要保持运行，Accio 才能联网。" htmlFor="st-tray">
            <Switch id="st-tray" checked={s.minimizeToTray} onCheckedChange={(v) => update({ minimizeToTray: v })} />
          </SettingRow>
          <SettingRow title="开机自动启动" description="登录 Windows 后在托盘中静默运行。" htmlFor="st-login">
            <Switch id="st-login" checked={s.openAtLogin} onCheckedChange={(v) => update({ openAtLogin: v })} />
          </SettingRow>
          <SettingRow title="外观">
            <Segmented
              label="外观"
              value={s.theme}
              onChange={(v) => update({ theme: v })}
              options={[
                { value: 'system', label: <span className="inline-flex items-center gap-1.5"><Monitor className="size-3.5" />系统</span> },
                { value: 'light', label: <span className="inline-flex items-center gap-1.5"><Sun className="size-3.5" />浅色</span> },
                { value: 'dark', label: <span className="inline-flex items-center gap-1.5"><Moon className="size-3.5" />深色</span> },
              ]}
            />
          </SettingRow>
        </Group>

        <Group title="隐私与调试">
          <SettingRow title="API Key 加密" description="使用 Windows 数据保护 API（DPAPI）加密，只有当前 Windows 用户能解密。">
            {state.encryptionAvailable ? (
              <Badge tone="success">
                <ShieldCheck />
                已启用
              </Badge>
            ) : (
              <Badge tone="warning">不可用</Badge>
            )}
          </SettingRow>
          <SettingRow title="捕获请求内容" description="仅在内存保留最近 30 次请求，单条最多 2 MiB、合计 16 MiB；超限会注明省略。关闭或重启后清除，不写入磁盘。" htmlFor="st-debug">
            <Switch id="st-debug" checked={s.debugCapture} onCheckedChange={(v) => update({ debugCapture: v })} />
          </SettingRow>
          <SettingRow title="数据目录" description={<span className="font-mono text-[12px]">{state.dataDir}</span>}>
            <Button size="sm" onClick={() => void api.openPath(state.dataDir)}>
              <FolderOpen />
              打开
            </Button>
          </SettingRow>
        </Group>

        <Card className="flex items-center gap-4 p-5">
          <AppLogo className="size-11" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">Accio BYOK {state.version}</div>
            <div className="text-[12.5px] leading-relaxed text-muted">为 Accio 带来自有模型 Key、热切换、用量统计与会话备份。社区工具，与阿里巴巴或 Accio 官方无关。</div>
          </div>
        </Card>
      </fieldset>
    </>
  )
}
