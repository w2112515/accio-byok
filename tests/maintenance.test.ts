import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { it } from 'node:test'
import { setLanguage } from '../src/shared/i18n.ts'
setLanguage('en')
import { Maintenance, diagnosticPreview } from '../src/main/maintenance.ts'
import { readProviderUsage } from '../src/main/provider-usage.ts'
import type { Provider, RequestLog } from '../src/shared/types.ts'

const box = { available: () => true, encrypt: (s: string) => Buffer.from(s).toString('base64'), decrypt: (s: string) => Buffer.from(s, 'base64').toString() }
const payload = Buffer.from('synthetic executable bytes; never launched')
const asset = { name: 'Accio-BYOK-Setup-1.5.0.exe', size: payload.length, browser_download_url: 'https://github.com/w2112515/accio-byok/releases/download/v1.5.0/Accio-BYOK-Setup-1.5.0.exe', digest: `sha256:${createHash('sha256').update(payload).digest('hex')}` }
it('requires trusted release download, verifies bytes again before launch and excludes OAuth vault from backup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-update-'))
  fs.writeFileSync(path.join(dir, 'config.json'), '{"version":1}')
  fs.writeFileSync(path.join(dir, 'authorization.enc'), 'fixture-OAuth-vault')
  let destination = 'https://release-assets.githubusercontent.com/synthetic/update'
  const maintenance = new Maintenance(dir, '1.4.0', async (url, init) => {
    assert.equal(new Headers(init.headers).has('authorization'), false)
    if (url.startsWith('https://api.github.com/')) return Response.json([{ tag_name: 'v1.5.0', body: 'Fixture release', assets: [asset] }])
    if (url === asset.browser_download_url) return new Response(null, { status: 302, headers: { location: destination } })
    assert.equal(url, 'https://release-assets.githubusercontent.com/synthetic/update')
    return new Response(payload)
  }, box)
  try {
    assert.equal((await maintenance.check()).newer, true)
    destination = 'https://untrusted.test/update'
    await assert.rejects(maintenance.download(asset.name), /untrusted/)
    destination = 'https://release-assets.githubusercontent.com/synthetic/update'
    const downloaded = await maintenance.download(asset.name)
    assert.equal(await maintenance.verifiedInstallPath(), downloaded.path)
    const backup = JSON.parse(box.decrypt(fs.readFileSync(downloaded.configBackup, 'utf8')))
    assert.equal(backup.config, '{"version":1}')
    assert.equal(backup.credentialVaultExcluded, true)
    assert.ok(!JSON.stringify(backup).includes('fixture-OAuth-vault'))
    fs.writeFileSync(downloaded.path, 'tampered')
    await assert.rejects(maintenance.verifiedInstallPath(), /changed/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

it('default diagnostics use a whitelist and optional capture redacts credentials before preview', () => {
  const log = { ts: 0, status: 'error', providerName: 'private-account', error: 'secret-error', conversationId: 'private-thread', inputTokens: 4 } as RequestLog
  const safe = diagnosticPreview('1.4.0', { proxyRunning: true, accioRunning: false, providerCount: 1 }, [log])
  assert.ok(!/private-account|secret-error|private-thread/.test(safe.content))
  assert.equal(JSON.parse(safe.content).requests[0].inputTokens, 4)
  const optIn = diagnosticPreview('1.4.0', { proxyRunning: true, accioRunning: false, providerCount: 1 }, [], [{ id: 'capture-id', request: { text: 'private-prose fixture-secret', api_key: 'api-secret' }, events: ['Bearer sk-abcdefghijklmnop'] }], (s) => s.replaceAll('fixture-secret', '[REDACTED]'))
  assert.ok(optIn.includesContent && optIn.content.includes('private-prose'))
  assert.ok(!/fixture-secret|api-secret|sk-abcdefghijklmnop|capture-id/.test(optIn.content))
})

it('usage reads do not divert a custom connection key or infer undocumented quota units', async () => {
  const p: Provider = { id: 'p', name: 'test', presetId: 'deepseek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'synthetic-key', model: 'm', modelOverrides: {}, createdAt: 0 }
  let calls = 0
  const get = async (url: string, init: RequestInit) => { calls++; assert.equal(url, 'https://api.deepseek.com/user/balance'); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-key'); return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '9.50' }] }) }
  const snapshot = await readProviderUsage(p, get)
  assert.equal(snapshot.fields[0].value, '9.50')
  await assert.rejects(readProviderUsage({ ...p, baseUrl: 'https://relay.test/v1' }, get))
  assert.equal(calls, 1)
  const mini = await readProviderUsage({ ...p, presetId: 'minimax', authMode: 'subscription-key', baseUrl: 'https://api.minimax.io/v1' }, async () => Response.json({ model_remains: [{ remains_time: 2500 }], base_resp: { status_code: 0 } }))
  assert.equal(mini.fields[0].label, 'model_remains.0.remains_time')
  assert.equal(mini.fields[0].value, '2500')
})
