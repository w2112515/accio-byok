import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AccioModelInfo } from '../shared/types.ts'

export const ACCIO_DIR = path.join(os.homedir(), '.accio')
export const ACCIO_APPDATA = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Accio')
export const DEFAULT_GATEWAY = 'https://phoenix-gw.alibaba.com'

function run(cmd: string, args: string[], strict = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      if (strict && err) reject(new Error(`无法检查 Accio 进程：${err.message}`))
      else resolve(String(stdout ?? ''))
    })
  })
}

export function findAccioExe(configured?: string): string {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  const candidates = [
    configured,
    path.join(local, 'Programs', 'Accio', 'Accio.exe'),
    path.join(local, 'Programs', 'accio', 'Accio.exe'),
    path.join(local, 'Accio', 'Accio.exe'),
    'C:\\Program Files\\Accio\\Accio.exe',
    'D:\\software\\accio\\Accio.exe',
  ].filter((p): p is string => Boolean(p))
  return candidates.find((p) => fs.existsSync(p)) ?? ''
}

/** Look the install location up in the uninstall registry (per-user and machine). */
export async function findAccioExeFromRegistry(): Promise<string> {
  for (const hive of ['HKCU', 'HKLM']) {
    const out = await run('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'Accio', '/d'])
    const m = out.match(/InstallLocation\s+REG_\w+\s+(.+)/i) ?? out.match(/DisplayIcon\s+REG_\w+\s+"?([^",\r\n]+Accio\.exe)/i)
    if (m) {
      const p = m[1].trim()
      const exe = p.toLowerCase().endsWith('.exe') ? p : path.join(p, 'Accio.exe')
      if (fs.existsSync(exe)) return exe
    }
  }
  return ''
}

export async function listAccioPids(): Promise<number[]> {
  const out = await run('tasklist', ['/FI', 'IMAGENAME eq Accio.exe', '/FO', 'CSV', '/NH'], true)
  return out
    .split(/\r?\n/)
    .map((l) => l.match(/^"Accio\.exe","(\d+)"/i)?.[1])
    .filter((x): x is string => Boolean(x))
    .map(Number)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Ask Accio to close, then force it after a grace period. */
export async function stopAccio(): Promise<void> {
  if (!(await listAccioPids()).length) return
  await run('taskkill', ['/IM', 'Accio.exe', '/T'])
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    if (!(await listAccioPids()).length) return
  }
  await run('taskkill', ['/IM', 'Accio.exe', '/T', '/F'])
  for (let i = 0; i < 10; i++) {
    await sleep(300)
    if (!(await listAccioPids()).length) return
  }
  throw new Error('Accio 仍在运行，未能关闭。请保存任务并手动关闭后重试。')
}

/** Launch Accio; with a gateway URL every gateway request goes through our proxy. */
export async function launchAccio(exe: string, gatewayUrl?: string): Promise<void> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    // Don't leak our own Electron runtime settings into another Electron app.
    if (/^(ELECTRON_|CHROME_|NODE_OPTIONS$|GATEWAY_BASE_URL$|ACCIO_GATEWAY_URL$)/i.test(k)) continue
    env[k] = v
  }
  if (gatewayUrl) env.GATEWAY_BASE_URL = gatewayUrl
  const child = spawn(exe, [], { cwd: path.dirname(exe), env, detached: true, stdio: 'ignore', windowsHide: false })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

export function readModelCatalog(): AccioModelInfo[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ACCIO_DIR, 'model_cache.json'), 'utf8')) as {
      snapshots?: Record<string, { data?: { provider?: string; providerDisplayName?: string; modelList?: any[] }[] }>
    }
    const seen = new Map<string, AccioModelInfo>()
    for (const snap of Object.values(j.snapshots ?? {})) {
      for (const group of snap.data ?? []) {
        for (const m of group.modelList ?? []) {
          if (!m?.modelCode || seen.has(m.modelCode)) continue
          seen.set(m.modelCode, {
            code: m.modelCode,
            name: m.modelDisplayName ?? m.modelCode,
            provider: group.providerDisplayName ?? group.provider ?? '',
            visible: m.visible !== false,
          })
        }
      }
    }
    return [...seen.values()]
  } catch {
    return []
  }
}

/** The gateway Accio used last (region builds may differ), read from the tail of its log. */
export function detectUpstreamGateway(): string {
  const file = path.join(ACCIO_DIR, 'logs', 'sdk.log')
  try {
    const fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, 4 * 1024 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    fs.closeSync(fd)
    const matches = [...buf.toString('utf8').matchAll(/gatewayBaseUrl[=:]\\?"?(https:\/\/[a-z0-9.-]+)/gi)].map((m) => m[1])
    const remote = matches.filter((u) => !/127\.0\.0\.1|localhost/.test(u))
    return remote.at(-1) ?? DEFAULT_GATEWAY
  } catch {
    return DEFAULT_GATEWAY
  }
}
