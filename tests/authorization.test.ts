import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign } from 'node:crypto'
import { it } from 'node:test'
import { setLanguage } from '../src/shared/i18n.ts'
setLanguage('en')
import { AuthorizationStore, validateIdentity } from '../src/main/authorization.ts'
import type { Provider } from '../src/shared/types.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256' }
const jwt = (claims: Record<string, unknown>) => {
  const body = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'client-one', exp: Date.now() / 1000 + 3600, sub: 'account-one', ...claims })).toString('base64url')}`
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`
}
const box = { available: () => true, encrypt: (s: string) => `test:${Buffer.from(s).toString('base64')}`, decrypt: (s: string) => { if (!s.startsWith('test:')) throw new Error('invalid fixture'); return Buffer.from(s.slice(5), 'base64').toString() } }
const provider = (id: string): Provider => ({ id: 'fixture', name: 'ChatGPT', presetId: 'openai', kind: 'openai', authMode: 'openai-oauth', credentialId: id, baseUrl: 'https://api.openai.com/v1', openaiApi: 'responses', fundingSource: 'subscription', apiKey: '', model: 'fixture', modelOverrides: {}, createdAt: 0 })

it('rejects forged identity, wrong issuer/audience/nonce and expired tokens', () => {
  assert.equal(validateIdentity(jwt({ nonce: 'n' }), [jwk], 'client-one', 'n').subject, 'account-one')
  for (const claims of [{ iss: 'https://evil.test' }, { aud: 'other' }, { aud: ['client-one', 'other'] }, { nonce: 'wrong' }, { exp: 0 }]) assert.throws(() => validateIdentity(jwt(claims), [jwk], 'client-one', 'n'))
  const forged = jwt({ nonce: 'n' }).split('.'); forged[2] = Buffer.alloc(256).toString('base64url')
  assert.throws(() => validateIdentity(forged.join('.'), [jwk], 'client-one', 'n'), /signature/)
})

it('binds loopback callbacks, serializes refresh, isolates credentials and persists quota pauses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-auth-'))
  const file = path.join(dir, 'vault.enc')
  let nonce = ''; let refreshCount = 0; let wrongIdentity = false
  const store = new AuthorizationStore(file, box, async (url, init) => {
    if (url.endsWith('jwks.json')) return Response.json({ keys: [jwk] })
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 })
    assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token')
    const params = new URLSearchParams(String(init.body))
    if (params.get('grant_type') === 'refresh_token') { refreshCount++; await new Promise((r) => setTimeout(r, 25)) }
    return Response.json({ access_token: refreshCount ? 'new-access' : 'initial-access', refresh_token: refreshCount ? 'rotated-refresh' : 'initial-refresh', id_token: jwt({ nonce, sub: wrongIdentity ? 'account-two' : 'account-one' }), token_type: 'Bearer', expires_in: refreshCount ? 3600 : 30, scope: 'openid offline_access chatgpt.tokens.use.direct' })
  })
  const browser = async (authUrl: string) => {
    const auth = new URL(authUrl); nonce = auth.searchParams.get('nonce')!
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    const callback = new URL(auth.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', 'spoof'); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('client_id', 'client-one')
    assert.equal((await fetch(callback)).status, 400)
    callback.searchParams.set('state', auth.searchParams.get('state')!)
    assert.equal((await fetch(callback)).status, 200)
    assert.equal((await fetch(callback)).status, 400, 'callback is single-use')
  }
  try {
    const account = await store.signIn('openai', browser)
    assert.equal(account.firstSignIn, true)
    assert.ok(!JSON.stringify(store.views()).includes('initial-access'))
    const results = await Promise.all([store.prepare(provider(account.id)), store.prepare(provider(account.id))])
    assert.equal(refreshCount, 1)
    assert.equal(results[0].apiKey, 'new-access'); assert.equal(results[1].apiKey, 'new-access')
    await assert.rejects(store.prepare({ ...provider(account.id), baseUrl: 'https://relay.test/v1' }))
    await assert.rejects(store.prepare(provider('another-registration')))
    wrongIdentity = true
    await assert.rejects(store.signIn('openai', browser, account.id), /did not match/)
    assert.equal((await store.prepare(provider(account.id))).apiKey, 'new-access')
    store.pause(account.id, 'usage-paused')
    await assert.rejects(store.prepare(provider(account.id)), /usage-paused/)
    const reopened = new AuthorizationStore(file, box, async () => { throw new Error('unexpected refresh') })
    await assert.rejects(reopened.prepare(provider(account.id)), /usage-paused/)
    store.resume(account.id)
    assert.equal((await store.prepare(provider(account.id))).apiKey, 'new-access')
    assert.equal((await store.signOut(account.id)).remoteRevoked, true)
    await assert.rejects(store.prepare(provider(account.id)), /Sign in/)
    const plaintext = box.decrypt(fs.readFileSync(file, 'utf8'))
    assert.ok(!plaintext.includes('rotated-refresh') && !plaintext.includes('new-access'))
    assert.ok(plaintext.includes('client-one'), 'registration identity survives sign-out')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

it('cancellation during exchange never saves the returned credential', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-cancel-'))
  let store: AuthorizationStore
  store = new AuthorizationStore(path.join(dir, 'vault.enc'), box, async () => { store.cancel(); return Response.json({ key: 'must-not-save' }) })
  try {
    await assert.rejects(store.signIn('openrouter', async (url) => { const callback = new URL(new URL(url).searchParams.get('callback_url')!); callback.searchParams.set('code', 'fixture'); await fetch(callback) }), /cancelled/)
    assert.deepEqual(store.views(), [])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
