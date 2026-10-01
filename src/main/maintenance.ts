import { tx } from '../shared/i18n.ts'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { DiagnosticPreview, RequestCapture, RequestLog, UpdateInfo } from '../shared/types.ts'
import type { SecretBox } from './config.ts'
import type { FetchLike } from './proxy/adapters/common.ts'

const REPO = 'https://github.com/w2112515/accio-byok'
const RELEASES = 'https://api.github.com/repos/w2112515/accio-byok/releases?per_page=10'
type Asset = { name: string; url: string; size: number; sha256: string }

export function newerVersion(next: string, current: string): boolean {
  const n = next.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
  const c = current.match(/^(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
  if (!n || !c) return false
  for (let i = 0; i < 3; i++) if (n[i] !== c[i]) return n[i] > c[i]
  return false
}

/** No credentials, arbitrary destinations or silent installation. */
export class Maintenance {
  private dir: string
  private version: string
  private fetch: FetchLike
  private box: SecretBox
  private assets = new Map<string, Asset>()
  private info?: UpdateInfo
  private ready?: { path: string; sha256: string; configBackup: string }
  constructor(dir: string, version: string, fetch: FetchLike, box: SecretBox) { this.dir = dir; this.version = version; this.fetch = fetch; this.box = box }

  async check(): Promise<UpdateInfo> {
    this.assets.clear(); this.info = undefined
    const res = await this.fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20_000), redirect: 'error', credentials: 'omit' })
    if (!res.ok) throw new Error(`Release check failed (HTTP ${res.status})`)
    const list = await res.json() as any[]
    const release = Array.isArray(list) && list.find((r) => !r.draft && /^v?\d+\.\d+\.\d+$/.test(r.tag_name))
    if (!release) throw new Error(tx("No supported public release was returned", "未返回支持的公开版本"))
    const version = release.tag_name.replace(/^v/, '')
    const pageUrl = `${REPO}/releases/tag/${encodeURIComponent(release.tag_name)}`
    const assets: UpdateInfo['assets'] = []
    for (const a of Array.isArray(release.assets) ? release.assets : []) {
      if (![ `Accio-BYOK-Setup-${version}.exe`, `Accio-BYOK-${version}-portable.exe` ].includes(a.name) || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > 400 * 1024 * 1024) continue
      const sha256 = /^sha256:[a-f0-9]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : undefined
      const expected = `${REPO}/releases/download/${encodeURIComponent(release.tag_name)}/${a.name}`
      if (a.browser_download_url !== expected) continue
      assets.push({ name: a.name, size: a.size, sha256 })
      if (sha256) this.assets.set(a.name, { name: a.name, url: expected, size: a.size, sha256 })
    }
    return this.info = { version, newer: newerVersion(version, this.version), prerelease: !!release.prerelease, checkedAt: Date.now(), notes: String(release.body ?? '').slice(0, 20_000), pageUrl, assets }
  }

  async download(name: string): Promise<{ path: string; configBackup: string }> {
    const asset = this.assets.get(name)
    if (!asset || !this.info?.newer) throw new Error(tx("Check for a newer release with a published SHA-256 digest first", "请先检查包含公开 SHA-256 校验值的新版本"))
    const dir = path.join(this.dir, 'updates')
    await fsp.mkdir(dir, { recursive: true })
    const temp = path.join(dir, `${randomUUID()}.part`)
    const target = path.join(dir, asset.name)
    let url = asset.url
    const signal = AbortSignal.timeout(10 * 60_000)
    let res: Response | undefined
    for (let i = 0; i < 5; i++) {
      const destination = new URL(url)
      if (destination.protocol !== 'https:' || destination.username || destination.password || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(destination.hostname)) throw new Error(tx("Update download redirected to an untrusted destination", "更新下载重定向到了不受信任的地址"))
      res = await this.fetch(url, { redirect: 'manual', credentials: 'omit', signal })
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        await res.body?.cancel()
        if (!location) throw new Error(tx("Update redirect has no destination", "更新重定向未提供目标地址"))
        url = new URL(location, url).href
      } else break
    }
    if (!res?.ok || !res.body) throw new Error(`Update download failed (HTTP ${res?.status ?? 0})`)
    const hash = createHash('sha256')
    let size = 0
    const handle = await fsp.open(temp, 'wx')
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > asset.size) throw new Error(tx("Update is larger than its release manifest", "更新包超出发布清单记录的大小"))
        hash.update(value)
        await handle.writeFile(value)
      }
      if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error(tx("Update SHA-256 verification failed", "更新包 SHA-256 校验失败"))
      await handle.close()
      await fsp.rename(temp, target)
      const configBackup = await this.backupConfig()
      this.ready = { path: target, sha256: asset.sha256, configBackup }
      return { path: target, configBackup }
    } catch (e) {
      await reader.cancel().catch(() => {})
      await handle.close().catch(() => {})
      await fsp.rm(temp, { force: true })
      throw e
    }
  }

  private async backupConfig(): Promise<string> {
    const filename = path.join(this.dir, 'config.json')
    const config = fs.existsSync(filename) ? await fsp.readFile(filename, 'utf8') : undefined
    const saved = path.join(this.dir, 'updates', `config-before-${this.version}-${Date.now()}-${randomUUID().slice(0, 8)}.enc`)
    await fsp.writeFile(saved, this.box.encrypt(JSON.stringify({ version: this.version, config, createdAt: Date.now(), credentialVaultExcluded: true })), { flag: 'wx' })
    return saved
  }

  async verifiedInstallPath(): Promise<string> {
    if (!this.ready) throw new Error(tx("Download and verify an update first", "请先下载并校验更新"))
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(this.ready.path)) hash.update(chunk)
    if (hash.digest('hex') !== this.ready.sha256) { this.ready = undefined; throw new Error(tx("Downloaded update changed; download it again", "已下载的更新包发生变化，请重新下载")) }
    // Capture changes made since the download; OAuth token rotations are never rolled back.
    this.ready.configBackup = await this.backupConfig()
    return this.ready.path
  }
}

export function diagnosticPreview(version: string, state: { proxyRunning: boolean; accioRunning: boolean; accioVersion?: string; providerCount: number }, logs: RequestLog[], captures?: RequestCapture[], redact = (s: string) => s): DiagnosticPreview {
  const rows = logs.slice(0, 50).map((l) => ({ ts: l.ts, mode: l.mode, status: l.status, httpStatus: l.httpStatus, notSent: l.notSent, durationMs: l.durationMs, ttftMs: l.ttftMs, inputTokens: l.inputTokens, outputTokens: l.outputTokens, cachedTokens: l.cachedTokens, cacheWriteTokens: l.cacheWriteTokens, usageReported: l.usageReported, toolCalls: l.toolCalls, fundingSource: l.fundingSource }))
  const report: Record<string, unknown> = { app: 'Accio BYOK', version, createdAt: new Date().toISOString(), ...state, requests: rows }
  if (captures) report.content = captures.slice(0, 3).map(({ request, upstreamRequest, events }) => ({ request, upstreamRequest, events }))
  let content = JSON.stringify(report, (k, v) => v !== undefined && v !== null && /token|secret|authorization|cookie|signature|encrypted_content|api.?key/i.test(k) && typeof v !== 'number' && !k.endsWith('Reported') ? '[REDACTED]' : v, 2)
  if (captures) content = redact(content).replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.\-+/=]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
  // Keep exported JSON valid and reviewable, even for very large captured conversations.
  if (content.length > 500_000) throw new Error(tx("Captured content is too large to preview. Export without conversation content.", "捕获内容过大，无法预览；请导出不含会话正文的报告"))
  return { id: randomUUID(), content, includesContent: !!captures }
}
