import { tx } from '../shared/i18n.ts'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto'
import type { AuthorizationView, Provider } from '../shared/types.ts'
import { normalizeProviderInput } from '../shared/provider-input.ts'
import type { SecretBox } from './config.ts'
import type { FetchLike } from './proxy/adapters/common.ts'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
type Service = AuthorizationView['service']
interface Credential {
  id: string; service: Service; clientId?: string; subject?: string; email?: string
  accessToken?: string; refreshToken?: string; idToken?: string; scopes: string[]; expiresAt?: number
  pauseReason?: string
}
interface Vault { version: 1; hostId: string; records: Credential[] }
type TokenResponse = { access_token?: string; refresh_token?: string; id_token?: string; scope?: string; token_type?: string; expires_in?: number; error?: string }

/** Strict OIDC validation: untrusted token data never determines a fetch URL. */
export function validateIdentity(token: string, keys: (JsonWebKey & { kid?: string; alg?: string })[], clientId: string, nonce?: string): { subject: string; email?: string } {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error(tx("Invalid OpenAI identity token", "OpenAI 身份令牌格式无效"))
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  const key = keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === 'RS256') && k.kty === 'RSA')
  if (header.alg !== 'RS256' || !key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error(tx("OpenAI identity signature verification failed", "OpenAI 身份签名验证失败"))
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const now = Date.now() / 1000
  if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId) || typeof claims.exp !== 'number' || claims.exp <= now || (claims.nbf && claims.nbf > now + 30) || typeof claims.sub !== 'string' || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)) throw new Error(tx("OpenAI identity, audience, expiry or nonce did not match", "OpenAI 身份、客户端、有效期或随机校验值不匹配"))
  return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined }
}

/** Tokens are encrypted as one atomic record and never returned over IPC. */
export class AuthorizationStore {
  private file: string
  private box: SecretBox
  private fetch: FetchLike
  private vault: Vault
  private refreshes = new Map<string, Promise<Credential>>()
  private pending?: { service: Service; existingId?: string; cancel(): void }
  private blocked = new Set<string>()
  loadError?: string

  constructor(file: string, box: SecretBox, fetch: FetchLike) {
    this.file = file; this.box = box; this.fetch = fetch
    this.vault = { version: 1, hostId: `urn:uuid:${randomUUID()}`, records: [] }
    try {
      const stored = JSON.parse(box.decrypt(fs.readFileSync(file, 'utf8'))) as Vault
      if (stored.version !== 1 || !/^urn:uuid:[a-f0-9-]+$/i.test(stored.hostId) || !Array.isArray(stored.records) || stored.records.some((r) => !r.id || !['openai', 'openrouter'].includes(r.service) || !Array.isArray(r.scopes))) throw new Error(tx("Invalid authorization storage", "授权存储格式无效"))
      this.vault = stored
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = tx('Saved authorization could not be read. The original file is preserved; use the original Windows account.', '无法读取保存的授权，已保留原文件；请使用原 Windows 账号打开。')
    }
  }

  private persist(next: Vault): void {
    if (this.loadError) throw new Error(this.loadError)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    fs.writeFileSync(temp, this.box.encrypt(JSON.stringify(next)), { mode: 0o600 })
    fs.renameSync(temp, this.file)
    this.vault = next
  }

  private save(record: Credential): void {
    this.persist({ ...this.vault, records: [...this.vault.records.filter((r) => r.id !== record.id), record] })
  }

  views(): AuthorizationView[] { return this.vault.records.map((r) => this.view(r)) }
  private view(r: Credential): AuthorizationView {
    return { id: r.id, service: r.service, label: `${r.email || (r.service === 'openai' ? 'ChatGPT' : 'OpenRouter')} · ${r.id.slice(-6)}`, connected: !!r.accessToken && !this.blocked.has(r.id), planEnabled: r.service !== 'openai' || r.scopes.includes('chatgpt.tokens.use.direct'), expiresAt: r.expiresAt, pauseReason: r.pauseReason }
  }
  cancel(): void { this.pending?.cancel() }
  redact(value: string): string {
    for (const r of this.vault.records) for (const secret of [r.accessToken, r.refreshToken, r.idToken]) if (secret) value = value.split(secret).join('[REDACTED]')
    return value
  }

  pause(id: string, reason: string): void {
    const record = this.vault.records.find((r) => r.id === id)
    if (record && record.pauseReason !== reason) {
      try { this.save({ ...record, pauseReason: reason }) } catch (e) { this.blocked.add(id); throw e }
    }
  }

  resume(id: string): void {
    const record = this.vault.records.find((r) => r.id === id)
    if (!record?.accessToken || this.blocked.has(id)) throw new Error(tx("Sign in before resuming requests", "恢复请求前请先登录"))
    this.save({ ...record, pauseReason: undefined })
  }

  async signIn(service: Service, openBrowser: (url: string) => Promise<void>, existingId?: string): Promise<AuthorizationView> {
    if (!['openai', 'openrouter'].includes(service)) throw new Error(tx("Unsupported authorization service", "不支持此授权服务"))
    if (this.pending) throw new Error(tx("A sign-in is already in progress. Complete or cancel it first.", "已有登录正在进行，请先完成或取消"))
    if (this.loadError) throw new Error(this.loadError)
    const existing = existingId ? this.vault.records.find((r) => r.id === existingId && r.service === service) : undefined
    if (existingId && !existing) throw new Error(tx("Saved authorization does not exist", "已保存授权不存在"))
    // Persist the installation identity before registration, even if the user cancels.
    this.persist(this.vault)
    const state = randomBytes(32).toString('base64url')
    const nonce = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    let settle: (url: URL) => void = () => {}
    let rejectAttempt: (error: Error) => void = () => {}
    const callback = new Promise<URL>((resolve, reject) => { settle = resolve; rejectAttempt = reject })
    // Attach immediately: cancellation can arrive while the browser is opening.
    void callback.catch(() => {})
    let consumed = false
    const controller = new AbortController()
    const stop = (error: Error) => { controller.abort(error); rejectAttempt(error) }
    const server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      res.setHeader('Referrer-Policy', 'no-referrer')
      const address = server.address() as { port: number }
      const host = `127.0.0.1:${address.port}`
      const url = new URL(req.url || '/', `http://${host}`)
      const gotState = url.searchParams.get('state') || ''
      const sameState = Buffer.byteLength(gotState) === Buffer.byteLength(state) && timingSafeEqual(Buffer.from(gotState), Buffer.from(state))
      if (req.method !== 'GET' || req.headers.host !== host || url.pathname !== '/auth/callback' || !sameState || consumed) { res.writeHead(400); res.end('Invalid or expired sign-in callback.'); return }
      consumed = true
      res.end('Return to Accio BYOK to finish signing in. You may close this tab.')
      settle(url)
    })
    const timer = setTimeout(() => stop(new Error(tx("Sign-in timed out. Please try again.", "登录超时，请重试"))), 5 * 60_000)
    const pending = { service, existingId, cancel: () => stop(new Error(tx("Sign-in cancelled. Existing connections are unchanged.", "已取消登录，原有连接保持不变"))) }
    this.pending = pending
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}/auth/callback`
      const auth = new URL(service === 'openai' ? `${ISSUER}/api/accounts/authorize` : 'https://openrouter.ai/auth')
      auth.searchParams.set('code_challenge', challenge)
      auth.searchParams.set('code_challenge_method', 'S256')
      if (service === 'openai') {
        for (const [k, v] of Object.entries({ client_id: existing?.clientId || 'dynamic_agent_client', ext_agent_host_id: this.vault.hostId, response_type: 'code', redirect_uri: redirect, scope: SCOPE, resource: RESOURCE, state, nonce })) auth.searchParams.set(k, v)
        if (!existing) auth.searchParams.set('agent_name_hint', 'Accio BYOK')
        else {
          if (existing.idToken) auth.searchParams.set('id_token_hint', existing.idToken)
          if (existing.email) auth.searchParams.set('login_hint', existing.email)
          if (!existing.scopes.includes('chatgpt.tokens.use.direct')) auth.searchParams.set('prompt', 'consent')
        }
      } else {
        // OpenRouter preserves callback query parameters; bind state there, as documented PKCE has no state parameter.
        auth.searchParams.set('callback_url', `${redirect}?state=${state}`)
        auth.searchParams.set('key_label', 'Accio BYOK')
      }
      await openBrowser(auth.href)
      controller.signal.throwIfAborted()
      const result = await callback
      controller.signal.throwIfAborted()
      if (result.searchParams.has('error')) throw new Error(tx("Authorization was declined or failed. Existing connections are unchanged.", "授权被拒绝或失败，原有连接保持不变"))
      const code = result.searchParams.get('code')
      if (!code) throw new Error(tx("Authorization callback did not contain a code", "授权回调未包含授权码"))
      let record: Credential
      if (service === 'openai') {
        const clientId = result.searchParams.get('client_id') || existing?.clientId
        if (!clientId || clientId === 'dynamic_agent_client' || (existing && existing.clientId !== clientId)) throw new Error(tx("OpenAI client registration did not match", "OpenAI 客户端注册信息不匹配"))
        const tokens = await this.tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: RESOURCE }, controller.signal)
        if (!tokens.id_token) throw new Error(tx("OpenAI did not return an identity token", "OpenAI 未返回身份令牌"))
        const identity = await this.identity(tokens.id_token, clientId, nonce, controller.signal)
        if (existing && existing.subject !== identity.subject) throw new Error(tx("The signed-in account did not match the selected registration", "登录账号与选中的授权记录不匹配"))
        record = this.applyTokens({ id: existing?.id || randomUUID(), service, clientId, ...identity, scopes: [] }, tokens)
      } else {
        const res = await this.fetch('https://openrouter.ai/api/v1/auth/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]), redirect: 'error' })
        if (!res.ok) throw new Error(`OpenRouter authorization exchange failed (HTTP ${res.status})`)
        const data = await res.json() as { key?: string }
        if (!data.key || typeof data.key !== 'string') throw new Error(tx("OpenRouter did not return an API key", "OpenRouter 未返回 API Key"))
        record = { id: existing?.id || randomUUID(), service, accessToken: data.key, scopes: [] }
      }
      // Nothing modifies the active provider until all validation and the encrypted write succeed.
      controller.signal.throwIfAborted()
      record.pauseReason = existing?.pauseReason
      this.save(record)
      this.blocked.delete(record.id)
      return { ...this.view(record), firstSignIn: !existing }
    } finally {
      clearTimeout(timer)
      server.close(); server.closeAllConnections()
      if (this.pending === pending) this.pending = undefined
    }
  }

  private async identity(token: string, client: string, nonce?: string, signal?: AbortSignal) {
    const res = await this.fetch(`${ISSUER}/.well-known/jwks.json`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000), redirect: 'error' })
    if (!res.ok) throw new Error(tx("Could not verify OpenAI identity. Try signing in again later.", "无法验证 OpenAI 身份，请稍后重新登录"))
    const data = await res.json() as { keys: JsonWebKey[] }
    return validateIdentity(token, data.keys, client, nonce)
  }

  private async tokenRequest(body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
    const res = await this.fetch(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), redirect: 'error' })
    const data = await res.json() as TokenResponse
    if (!res.ok) {
      const code = typeof data.error === 'string' && /^[a-z_]+$/.test(data.error) ? data.error : `http_${res.status}`
      throw Object.assign(new Error(`OpenAI authorization: ${code}`), { code })
    }
    return data
  }

  private applyTokens(record: Credential, t: TokenResponse): Credential {
    if (!t.access_token || !t.refresh_token || t.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(t.expires_in) || t.expires_in! <= 0) throw new Error(tx("OpenAI returned an incomplete token set", "OpenAI 返回的令牌信息不完整"))
    return { ...record, accessToken: t.access_token, refreshToken: t.refresh_token, idToken: t.id_token || record.idToken, scopes: t.scope !== undefined ? t.scope.split(' ') : record.scopes, expiresAt: Date.now() + t.expires_in! * 1000 }
  }

  private async refresh(record: Credential): Promise<Credential> {
    let pending = this.refreshes.get(record.id)
    if (!pending) {
      pending = (async () => {
        let tokenReceived = false
        try {
          if (!record.refreshToken || !record.clientId) throw Object.assign(new Error(tx("Sign in again to continue", "请重新登录后继续")), { code: 'invalid_grant' })
          const t = await this.tokenRequest({ grant_type: 'refresh_token', client_id: record.clientId, refresh_token: record.refreshToken, resource: RESOURCE })
          tokenReceived = true
          if (t.id_token) {
            const identity = await this.identity(t.id_token, record.clientId)
            if (identity.subject !== record.subject) throw new Error(tx("Refreshed identity did not match the saved account", "刷新后的身份与保存的账号不匹配"))
          }
          const next = this.applyTokens({ ...record, pauseReason: this.vault.records.find((r) => r.id === record.id)?.pauseReason }, t)
          try { this.save(next) } catch {
            this.blocked.add(record.id)
            throw new Error(tx("Refreshed authorization could not be saved. Requests are blocked; fix storage and sign in again.", "无法保存刷新后的授权，已阻止请求；请修复存储后重新登录"))
          }
          return next
        } catch (e) {
          if (tokenReceived || ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes((e as { code?: string }).code || '')) {
            this.blocked.add(record.id)
            this.save({ ...record, accessToken: undefined, refreshToken: undefined, idToken: undefined, expiresAt: undefined })
          }
          throw e
        }
      })()
      this.refreshes.set(record.id, pending)
    }
    try { return await pending } finally { if (this.refreshes.get(record.id) === pending) this.refreshes.delete(record.id) }
  }

  async prepare(provider: Provider): Promise<Provider> {
    normalizeProviderInput(provider)
    if (!provider.authMode?.endsWith('-oauth')) return provider
    if (this.loadError) throw new Error(this.loadError)
    let record = this.vault.records.find((r) => r.id === provider.credentialId)
    const service = provider.authMode === 'openai-oauth' ? 'openai' : 'openrouter'
    if (!record || record.service !== service || this.blocked.has(record.id) || !record.accessToken) throw new Error(tx("Sign in to the selected account before sending requests", "发送请求前请登录所选账号"))
    if (record.service === 'openai' && (record.expiresAt || 0) < Date.now() + 60_000) record = await this.refresh(record)
    if (this.blocked.has(record.id)) throw new Error(tx("This account has been disconnected. Sign in again.", "此账号已断开连接，请重新登录"))
    if (record.pauseReason) throw new Error(record.pauseReason)
    if (record.service === 'openai' && !record.scopes.includes('chatgpt.tokens.use.direct')) throw new Error(tx("ChatGPT plan usage is not enabled. Continue with ChatGPT to enable permission.", "尚未启用 ChatGPT 套餐用量，请通过 Continue with ChatGPT 启用权限"))
    return { ...provider, apiKey: record.accessToken!, extraHeaders: undefined }
  }

  async signOut(id: string): Promise<{ remoteRevoked: boolean }> {
    const record = this.vault.records.find((r) => r.id === id)
    if (!record) throw new Error(tx("Saved authorization does not exist", "已保存授权不存在"))
    this.blocked.add(id)
    if (this.pending?.existingId === id) this.pending.cancel()
    // Let a rotating refresh finish before revoking its replacement.
    await this.refreshes.get(id)?.catch(() => {})
    const latest = this.vault.records.find((r) => r.id === id)!
    let remoteRevoked = false
    if (latest.service === 'openai' && latest.refreshToken && latest.clientId) {
      try {
        const res = await this.fetch(`${ISSUER}/api/accounts/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: latest.refreshToken, token_type_hint: 'refresh_token', client_id: latest.clientId }).toString(), signal: AbortSignal.timeout(20_000), redirect: 'error' })
        remoteRevoked = res.status === 200
      } catch { /* The caller explicitly receives the unconfirmed revocation state. */ }
    }
    this.save({ ...latest, accessToken: undefined, refreshToken: undefined, idToken: undefined, expiresAt: undefined })
    return { remoteRevoked }
  }
}
