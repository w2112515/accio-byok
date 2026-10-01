import assert from 'node:assert/strict'
import http from 'node:http'
import { it } from 'node:test'
import { protectedFetch, redactProviderError } from '../src/main/proxy/request-policy.ts'
import { normalizeProviderInput } from '../src/shared/provider-input.ts'
import { defaultSettings, validateSettings } from '../src/main/config.ts'
import { SUBSCRIPTION_ROUTES } from '../src/shared/provider-access.ts'

it('keeps subscription credentials on acknowledged official routes and rejects renderer evidence', () => {
  const input = { name: 'Subscription', kind: 'openai' as const, model: 'm', modelOverrides: {}, apiKey: 'fixture', openaiApi: 'chat' as const, authMode: 'subscription-key' as const }
  for (const [presetId, routes] of Object.entries(SUBSCRIPTION_ROUTES)) for (const route of routes) {
    assert.throws(() => normalizeProviderInput({ ...input, presetId, baseUrl: route.baseUrl }))
    const saved = normalizeProviderInput({ ...input, presetId, baseUrl: route.baseUrl, subscriptionAcknowledged: true, checks: [{ ok: true }], encryptedHeaders: 'forged' } as any)
    assert.equal(saved.fundingSource, 'subscription')
    assert.ok(!('checks' in saved) && !('encryptedHeaders' in saved))
    assert.throws(() => normalizeProviderInput({ ...saved, baseUrl: 'https://relay.test/v1' }))
    assert.throws(() => normalizeProviderInput({ ...saved, extraHeaders: { Authorization: 'Bearer other' } }))
  }
})

it('does not follow redirects carrying bearer or custom credentials', async () => {
  let leaks = 0
  const sink = http.createServer((_req, res) => { leaks++; res.end('unexpected') })
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve))
  const source = http.createServer((_req, res) => res.writeHead(307, { location: `http://127.0.0.1:${(sink.address() as any).port}/steal` }).end())
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(protectedFetch(fetch)(`http://127.0.0.1:${(source.address() as any).port}/v1/responses`, { method: 'POST', body: '{"private":"history"}', headers: { authorization: 'Bearer test-key', 'x-relay-key': 'custom-secret' } }), /阻止转发/)
    assert.equal(leaks, 0)
  } finally {
    await Promise.all([new Promise<void>((r) => source.close(() => r())), new Promise<void>((r) => sink.close(() => r()))])
  }
})

it('honors Retry-After without replaying and counts concurrency until body cancellation', async () => {
  let clock = 1_000_000
  let calls = 0
  let limited = true
  const guarded = protectedFetch(async () => {
    calls++
    return limited ? new Response('limited', { status: 429, headers: { 'retry-after': '120' } }) : new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])) } }))
  }, () => clock)
  const init = { headers: { authorization: 'Bearer test-key' } }
  const url = 'https://relay.example/v1/responses'
  await (await guarded(url, init)).text()
  assert.deepEqual(guarded.inspect(url, init), { active: 0, limit: 4, retryAt: clock + 120_000 })
  await assert.rejects(guarded(url, init), (e: any) => e.notSent === true && /120 秒/.test(e.message))
  assert.equal(calls, 1)
  clock += 120_001
  limited = false
  const responses = await Promise.all(Array.from({ length: 4 }, () => guarded(url, init)))
  assert.deepEqual(guarded.inspect(url, init), { active: 4, limit: 4, retryAt: undefined })
  await assert.rejects(guarded(url, init), (e: any) => e.notSent === true && /4 个请求/.test(e.message))
  assert.equal(calls, 5)
  await responses[0].body!.cancel()
  const next = await guarded(url, init)
  await Promise.all([...responses.slice(1), next].map((res) => res.body!.cancel()))
  assert.equal(calls, 6)
  assert.equal(guarded.inspect(url, init).active, 0)
})

it('requires HTTPS for remote official gateways while permitting local fixtures', () => {
  assert.throws(() => validateSettings(defaultSettings({ upstreamGateway: 'http://gateway.invalid' })), /必须使用 HTTPS/)
  for (const url of ['https://gateway.invalid', 'http://127.0.0.1:1234', 'http://localhost:1234', 'http://[::1]:1234']) {
    assert.equal(validateSettings(defaultSettings({ upstreamGateway: url })).upstreamGateway, url)
  }
})

it('requires explicit remote HTTP consent and rejects unsafe headers while retaining subpaths', () => {
  const input = { name: 'Relay', kind: 'openai' as const, baseUrl: 'http://relay.example/custom/v1/responses', model: 'm', apiKey: 'test-key', modelOverrides: {} }
  assert.throws(() => normalizeProviderInput(input), /明文传输/)
  const allowed = normalizeProviderInput({ ...input, allowInsecureHttp: true })
  assert.equal(allowed.baseUrl, 'http://relay.example/custom/v1')
  assert.equal(allowed.openaiApi, 'responses')
  for (const name of ['Host', 'Content-Length', 'Cookie', 'Transfer-Encoding', 'Proxy-Authorization']) assert.throws(() => normalizeProviderInput({ ...input, allowInsecureHttp: true, extraHeaders: { [name]: 'x' } }), /不能覆盖/)
  assert.equal(normalizeProviderInput({ ...input, baseUrl: 'http://127.0.0.1:8317/v1' }).baseUrl, 'http://127.0.0.1:8317/v1')
  assert.equal(normalizeProviderInput({ ...input, kind: 'anthropic', baseUrl: 'https://relay.example/antigravity/v1/messages' }).baseUrl, 'https://relay.example/antigravity')
  assert.equal(redactProviderError('test-key and custom-secret', { ...input, id: 'test', createdAt: 0, extraHeaders: { 'X-Key': 'custom-secret' } }), '[已隐藏凭据] and [已隐藏凭据]')
  assert.equal(redactProviderError('invalid auth-secret', { ...input, id: 'test', createdAt: 0, extraHeaders: { Authorization: 'Bearer auth-secret' } }), 'invalid [已隐藏凭据]')
})
