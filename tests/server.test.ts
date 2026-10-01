import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import zlib from 'node:zlib'
import type { Provider } from '../src/shared/types.ts'
import { wrapSignature } from '../src/main/proxy/accio.ts'
import { ProxyServer, type Target } from '../src/main/proxy/server.ts'
import { consume, sseResponse } from './accio-client.ts'

let gateway: http.Server
let gatewayUrl = ''
const seen: { method: string; url: string; body: string; headers: http.IncomingHttpHeaders }[] = []

const provider: Provider = {
  id: 'pv1',
  name: 'Mock OpenAI',
  kind: 'openai',
  baseUrl: 'https://mock.local/v1',
  apiKey: 'sk',
  model: 'default-model',
  modelOverrides: { 'accio-small': 'small-model' },
  createdAt: 0,
}

let target: Target = { mode: 'official' }
const logs: any[] = []
let proxy: ProxyServer
let proxyUrl = ''
let lastUpstreamModel = ''

before(async () => {
  gateway = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString(), headers: req.headers })
      if (req.url?.startsWith('/api/adk/llm/generateContent')) {
        const sse =
          `data: ${JSON.stringify({ content: { role: 'model', parts: [{ text: 'official hi' }] }, partial: true, turnComplete: false })}\n\n` +
          `data: ${JSON.stringify({ content: { role: 'model', parts: [] }, turnComplete: true, finishReason: 'STOP', usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 } })}\n\n`
        // Like the real gateway: compress when the client accepts it.
        if (String(req.headers['accept-encoding'] ?? '').includes('br')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'br' })
          const buf = zlib.brotliCompressSync(sse)
          res.write(buf.subarray(0, 20))
          res.end(buf.subarray(20))
        } else {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(sse)
        }
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] })
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
  })
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()))
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as any).port}`

  proxy = new ProxyServer({
    resolveTarget: () => target,
    upstream: () => gatewayUrl,
    fetch: async (_url, init) => {
      lastUpstreamModel = JSON.parse(String(init.body)).model
      return sseResponse([{ choices: [{ delta: { content: 'byok hi' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, 'data: [DONE]\n\n'])
    },
    onLog: (e) => logs.push(e),
    onAccioSeen: () => {},
    debugCapture: () => false,
  })
  const st = await proxy.start(0)
  assert.ok(st.running)
  proxyUrl = st.url
})

after(async () => {
  await proxy.stop()
  gateway.close()
})

function post(path: string, body: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; text: string; raw: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${proxyUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString(), raw: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('proxy server', () => {
  it('blocks an insecure remote gateway before forwarding credentials', async () => {
    const old = gatewayUrl
    const count = seen.length
    gatewayUrl = 'http://gateway.invalid'
    try {
      const r = await post('/api/account', Buffer.from('{}'), { authorization: 'Bearer fake-account-key' })
      assert.equal(r.status, 502)
      assert.match(r.text, /必须使用 HTTPS/)
      assert.equal(seen.length, count)
    } finally { gatewayUrl = old }
  })
  it('rejects browser cross-origin, DNS rebinding and form submissions before forwarding', async () => {
    const count = seen.length
    const entries = logs.length
    const blockedHeaders: Record<string, string>[] = [{ origin: 'https://attacker.example' }, { origin: 'null' }, { host: 'attacker.example' }, { 'sec-fetch-site': 'cross-site' }]
    for (const headers of blockedHeaders) {
      assert.equal((await post('/api/adk/llm/generateContent', Buffer.from('{}'), headers)).status, 403)
    }
    assert.equal((await post('/api/adk/llm/generateContent', Buffer.from('{}'), { 'content-type': 'text/plain' })).status, 415)
    const upgrade = await new Promise<number>((resolve, reject) => {
      const request = http.request(`${proxyUrl}/socket`, { headers: { connection: 'upgrade', upgrade: 'websocket', origin: 'https://attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode!) })
      request.on('error', reject)
      request.end()
    })
    assert.equal(upgrade, 403)
    assert.equal(seen.length, count)
    assert.equal(logs.length, entries)
  })
  it('can restart on the actual port without drifting back to the preferred port', async () => {
    const occupied = http.createServer()
    await new Promise<void>((r) => occupied.listen(0, '127.0.0.1', r))
    const preferred = (occupied.address() as any).port
    const local = new ProxyServer({ resolveTarget: () => ({ mode: 'official' }), upstream: () => gatewayUrl, fetch, onLog: () => {}, onAccioSeen: () => {}, debugCapture: () => false })
    try {
      const first = await local.start(preferred)
      assert.equal(first.running, true)
      assert.notEqual(first.port, preferred)
      await new Promise<void>((r) => occupied.close(() => r()))
      const restarted = await local.start(first.port, false)
      assert.equal(restarted.running, true)
      assert.equal(restarted.port, first.port)
    } finally {
      await local.stop()
      if (occupied.listening) await new Promise<void>((r) => occupied.close(() => r()))
    }
  })
  it('passes non-LLM traffic through unchanged', async () => {
    const res = await fetch(`${proxyUrl}/api/tool/feature?x=1`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, path: '/api/tool/feature?x=1' })
    assert.equal(seen.at(-1)?.headers.host, new URL(gatewayUrl).host)
  })

  it('official mode: decompresses, strips our signatures, forwards and logs usage', async () => {
    target = { mode: 'official' }
    const body = {
      model: '1Helix-abc',
      contents: [{ role: 'model', parts: [{ text: 't', thought: true, thought_signature: wrapSignature('pv1', 'S') }, { text: 'x', thought_signature: 'official-sig' }] }],
    }
    const res = await post('/api/adk/llm/generateContent?sg_k=1', zlib.gzipSync(JSON.stringify(body)), { 'content-encoding': 'gzip', 'accept-encoding': 'gzip, deflate, br' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-encoding'], 'br', 'compressed bytes must reach Accio untouched')
    res.text = zlib.brotliDecompressSync(res.raw).toString()
    const forwarded = JSON.parse(seen.at(-1)!.body)
    assert.equal(seen.at(-1)!.url, '/api/adk/llm/generateContent?sg_k=1')
    assert.equal(forwarded.contents[0].parts[0].thought_signature, undefined)
    assert.equal(forwarded.contents[0].parts[1].thought_signature, 'official-sig')
    assert.equal(consume(res.text).text, 'official hi')
    await new Promise((r) => setTimeout(r, 20))
    const log = logs.at(-1)
    assert.equal(log.mode, 'official')
    assert.equal(log.inputTokens, 11)
    assert.equal(log.outputTokens, 3)
    assert.equal(log.accioModel, '1Helix-abc')
  })

  it('byok mode: answers locally with model overrides', async () => {
    target = { mode: 'byok', provider }
    const before = seen.length
    const res = await post('/api/adk/llm/generateContent', Buffer.from(JSON.stringify({ model: 'accio-small', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })))
    assert.equal(res.status, 200)
    assert.equal(res.headers['x-accio-switch'], 'byok')
    const turn = consume(res.text)
    assert.equal(turn.text, 'byok hi')
    assert.equal(turn.turnComplete, true)
    assert.equal(lastUpstreamModel, 'small-model')
    assert.equal(seen.length, before, 'gateway must not be contacted in BYOK mode')
    const log = logs.at(-1)
    assert.equal(log.mode, 'byok')
    assert.equal(log.targetModel, 'small-model')
    assert.equal(log.inputTokens, 5)
  })
})
