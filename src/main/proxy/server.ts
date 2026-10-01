import { tr } from '../../shared/i18n.ts'
import http from 'node:http'
import { validateUpstreamGateway } from '../../shared/provider-input.ts'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import type { Provider, ProviderPricing, ProxyStatus, RequestLog, RequestStatus } from '../../shared/types.ts'
import { containsWrappedSignature, parseAccioRequest, stripWrappedSignatures } from './accio.ts'
import type { FetchLike } from './adapters/common.ts'
import { hostOf } from './adapters/common.ts'
import { resolveTargetModel, streamByok } from './byok.ts'
import { usableModelInfo } from '../../shared/model-info.ts'
import { estimateInput } from './context.ts'
import { connectionFingerprint } from '../connection-checks.ts'

export const GENERATE_PATH = '/api/adk/llm/generateContent'
const HEALTH_PATH = '/__accio_switch/health'

export type Target = { mode: 'official' } | { mode: 'byok'; provider: Provider }

export interface ProxyDeps {
  resolveTarget(): Target
  prepareProvider?(provider: Provider): Promise<Provider>
  upstream(): string
  fetch: FetchLike
  onLog(entry: Omit<RequestLog, 'id' | 'costUsd'>, capture?: { request: unknown; upstreamRequest?: unknown; events: string[] }, pricing?: ProviderPricing): void
  onAccioSeen(): void
  debugCapture(): boolean
  idleTimeoutMs?(): number
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']

function readBody(req: http.IncomingMessage, limit = 200 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function decodeBody(buf: Buffer, encoding: string | undefined): Promise<Buffer> {
  const options = { maxOutputLength: 200 * 1024 * 1024 }
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return promisify(zlib.gunzip)(buf, options)
    case 'deflate':
      return promisify(zlib.inflate)(buf, options)
    case 'br':
      return promisify(zlib.brotliDecompress)(buf, options)
    case 'zstd':
      return promisify(zlib.zstdDecompress)(buf, options)
    case '':
    case 'identity':
      return buf
    default:
      throw new Error(tr("不支持的请求压缩编码"))
  }
}

function forwardHeaders(headers: http.IncomingHttpHeaders, host: string): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.includes(k)) continue
    out[k] = v
  }
  out.host = host
  return out
}

function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.includes(k)) continue
    out[k] = v
  }
  return out
}

function createDecoder(encoding: string | undefined): zlib.Gunzip | zlib.BrotliDecompress | zlib.Inflate | undefined {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip()
    case 'br':
      return zlib.createBrotliDecompress()
    case 'deflate':
      return zlib.createInflate()
    case 'zstd':
      return (zlib as unknown as { createZstdDecompress?: () => zlib.Inflate }).createZstdDecompress?.()
    default:
      return undefined
  }
}

/**
 * Incrementally reads official-gateway SSE to pick up usage for the request log. The
 * gateway compresses its SSE when Accio accepts it; the bytes forwarded to Accio are
 * untouched, only this copy is decompressed.
 */
class OfficialTap {
  private buf = ''
  private text = new StringDecoder('utf8')
  private decoder?: ReturnType<typeof createDecoder>
  firstFrameAt?: number
  usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, usageReported: false, cacheReadReported: false, cacheWriteReported: false }
  toolCalls = 0
  finishReason?: string
  error?: string

  setEncoding(encoding: string | undefined): void {
    this.decoder = createDecoder(encoding)
    this.decoder?.on('data', (c: Buffer) => this.parse(c))
    this.decoder?.on('error', () => {})
  }

  push(chunk: Buffer): void {
    if (this.decoder) this.decoder.write(chunk)
    else this.parse(chunk)
  }

  /** Resolves once everything pushed so far has been parsed. */
  end(): Promise<void> {
    const d = this.decoder
    if (!d) return Promise.resolve()
    return new Promise((resolve) => {
      d.once('end', resolve)
      d.once('error', () => resolve())
      d.end()
    })
  }

  private parse(chunk: Buffer): void {
    this.firstFrameAt ??= Date.now()
    this.buf += this.text.write(chunk)
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        this.frame(JSON.parse(data))
      } catch {
        /* ignore non-JSON */
      }
    }
  }

  private frame(f: Record<string, any>): void {
    const u = f.usageMetadata ?? f.usage_metadata
    if (u) {
      this.usage.usageReported = typeof (u.promptTokenCount ?? u.prompt_token_count) === 'number' && typeof (u.candidatesTokenCount ?? u.candidates_token_count) === 'number'
      this.usage.cacheReadReported = typeof (u.cachedContentTokenCount ?? u.cached_content_token_count) === 'number'
      this.usage.inputTokens = u.promptTokenCount ?? u.prompt_token_count ?? this.usage.inputTokens
      this.usage.outputTokens = u.candidatesTokenCount ?? u.candidates_token_count ?? this.usage.outputTokens
      this.usage.cachedTokens = u.cachedContentTokenCount ?? u.cached_content_token_count ?? this.usage.cachedTokens
      this.usage.reasoningTokens = u.thoughtsTokenCount ?? u.thoughts_token_count ?? this.usage.reasoningTokens
    }
    const parts: any[] = f.content?.parts ?? []
    if (f.turnComplete ?? f.turn_complete) this.toolCalls += parts.filter((p) => p.functionCall ?? p.function_call).length
    const fr = f.finishReason ?? f.finish_reason
    if (fr) this.finishReason = fr
    const err = f.errorMessage ?? f.error_message ?? f.errorCode ?? f.error_code
    if (err) this.error = String(err)
  }
}

export class ProxyServer {
  private server?: http.Server
  private agent = new https.Agent({ keepAlive: true, maxSockets: 64 })
  private sockets = new Set<net.Socket>()
  activeRequests = 0
  status: ProxyStatus = { running: false, port: 0, url: '' }
  private deps: ProxyDeps

  constructor(deps: ProxyDeps) {
    this.deps = deps
  }

  async start(preferredPort: number, allowFallback = true): Promise<ProxyStatus> {
    await this.stop()
    let lastError: unknown
    for (let port = preferredPort; port < Math.min(65536, preferredPort + (allowFallback ? 20 : 1)); port++) {
      try {
        await this.listen(port)
        const actual = (this.server?.address() as net.AddressInfo | null)?.port ?? port
        this.status = { running: true, port: actual, url: `http://127.0.0.1:${actual}`, startedAt: Date.now() }
        return this.status
      } catch (e) {
        lastError = e
      }
    }
    this.status = { running: false, port: preferredPort, url: '', error: String(lastError) }
    return this.status
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res))
      server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as net.Socket, head))
      server.on('connection', (s) => {
        this.sockets.add(s)
        s.on('close', () => this.sockets.delete(s))
      })
      server.keepAliveTimeout = 65_000
      server.headersTimeout = 70_000
      server.requestTimeout = 0
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        this.server = server
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.status = { ...this.status, running: false }
    if (!server) return
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private trustedLocalRequest(req: http.IncomingMessage): boolean {
    const host = req.headers.host
    const localHosts = [`127.0.0.1:${this.status.port}`, `localhost:${this.status.port}`]
    if (!host || !localHosts.includes(host.toLowerCase()) || req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    return !origin || localHosts.some((h) => origin === `http://${h}`)
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.trustedLocalRequest(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
      res.end(tr("此本地代理不接受网页跨域请求或非本机 Host"))
      return
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === GENERATE_PATH && req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      res.writeHead(415, { connection: 'close' })
      res.end(tr("模型请求必须使用 application/json"))
      return
    }
    if (path === HEALTH_PATH) {
      try {
        const target = this.deps.resolveTarget().mode
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, app: 'accio-switch', target }))
      } catch (e) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      }
      return
    }
    this.activeRequests++
    let completed = false
    const complete = () => { if (!completed) { completed = true; this.activeRequests-- } }
    res.once('finish', complete)
    res.once('close', complete)
    this.deps.onAccioSeen()
    if (req.method === 'POST' && path === GENERATE_PATH) {
      this.generate(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`[Accio BYOK] ${err instanceof Error ? err.message : String(err)}`)
      })
      return
    }
    this.passthrough(req, res)
  }

  // --- LLM route ----------------------------------------------------------

  private async generate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now()
    const raw = await readBody(req)
    const target = this.deps.resolveTarget()
    let json: Record<string, unknown>
    try {
      json = JSON.parse((await decodeBody(raw, req.headers['content-encoding'] as string | undefined)).toString('utf8'))
    } catch {
      // Unknown encoding/shape: let the official gateway deal with it untouched.
      if (target.mode === 'official') return this.passthrough(req, res, raw)
      throw new Error(tr("无法解析 Accio 请求体"))
    }

    if (target.mode === 'official') return this.officialGenerate(req, res, json, started)

    const accioReq = parseAccioRequest(json)
    let provider = target.provider
    const connection = connectionFingerprint(provider)
    try { if (this.deps.prepareProvider) provider = await this.deps.prepareProvider(provider) } catch (e) {
      this.deps.onLog({ ts: started, mode: 'byok', providerId: provider.id, providerName: provider.name, connectionFingerprint: connection, accioModel: accioReq.model, targetModel: resolveTargetModel(provider, accioReq.model), status: 'error', notSent: true, durationMs: Date.now() - started, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, error: e instanceof Error ? e.message : String(e), fundingSource: provider.fundingSource })
      throw e
    }
    const model = resolveTargetModel(provider, accioReq.model)
    const capture = this.deps.debugCapture() ? { request: json, upstreamRequest: undefined as unknown, events: [] as string[] } : undefined
    let captureBytes = 0
    let captureTruncated = false

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'x-accio-switch': 'byok',
    })
    res.flushHeaders()
    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', onClose)
    // Accio drops idle SSE streams after 90 s; slow reasoning models can exceed that.
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000)

    const result = await streamByok({
      req: accioReq,
      provider,
      model,
      fetch: this.deps.fetch,
      signal: controller.signal,
      idleTimeoutMs: this.deps.idleTimeoutMs?.(),
      write: (chunk) => {
        if (!res.writableEnded) res.write(chunk)
      },
      onUpstreamRequest: capture ? (b) => (capture.upstreamRequest = b) : undefined,
      onFrame: capture ? (f) => {
        captureBytes += Buffer.byteLength(f)
        if (captureBytes <= 1024 * 1024 && capture.events.length < 2000) capture.events.push(f)
        else if (!captureTruncated) {
          captureTruncated = true
          capture.events.push(tr("[采集已截断：达到 1 MiB 或 2000 帧限制]"))
        }
      } : undefined,
    })
    clearInterval(heartbeat)
    res.off('close', onClose)
    if (!res.writableEnded) res.end()

    this.deps.onLog(
      {
        ts: started,
        mode: 'byok',
        providerId: provider.id,
        providerName: provider.name,
        connectionFingerprint: connection,
        accioModel: accioReq.model,
        targetModel: model,
        status: result.status,
        httpStatus: result.httpStatus,
        notSent: result.notSent,
        durationMs: Date.now() - started,
        ttftMs: result.ttftMs,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
        error: result.error,
        conversationId: accioReq.conversationId,
        agentId: accioReq.agentId,
        pricingUpdatedAt: provider.pricingUpdatedAt,
        fundingSource: provider.fundingSource ?? 'api',
        contextWindow: usableModelInfo(provider, model)?.contextWindow,
        contextWindowKind: usableModelInfo(provider, model)?.windowKind,
        contextWindowSource: usableModelInfo(provider, model)?.source,
        contextWindowCheckedAt: usableModelInfo(provider, model)?.checkedAt,
        ...estimateInput(accioReq),
        errorCode: result.errorCode,
        requestId: result.requestId,
        ...result.usage,
      },
      capture,
      provider.fundingSource !== 'subscription' && provider.pricing && model === (provider.pricingModel ?? provider.model) ? {
        ...provider.pricing,
        cacheWriteInput: provider.pricing.cacheWriteInput ?? (provider.kind === 'anthropic' && hostOf(provider.baseUrl) === 'api.anthropic.com' && provider.pricing.input !== undefined ? provider.pricing.input * 1.25 : provider.pricing.input),
      } : undefined,
    )
  }

  private officialGenerate(req: http.IncomingMessage, res: http.ServerResponse, json: Record<string, unknown>, started: number): void {
    const text = JSON.stringify(json)
    const body = Buffer.from(containsWrappedSignature(text) ? JSON.stringify(stripWrappedSignatures(json)) : text)
    const headers = forwardHeaders(req.headers, '')
    delete headers['content-encoding']
    headers['content-length'] = String(body.length)
    const tap = new OfficialTap()
    const model = typeof json.model === 'string' ? json.model : ''
    let status: RequestStatus = 'ok'
    let httpStatus: number | undefined

    const finish = () => {
      this.deps.onLog({
        ts: started,
        mode: 'official',
        providerId: 'official',
        providerName: tr("Accio 官方"),
        accioModel: model,
        targetModel: model,
        status: tap.error ? 'error' : status,
        httpStatus,
        durationMs: Date.now() - started,
        ttftMs: tap.firstFrameAt ? tap.firstFrameAt - started : undefined,
        toolCalls: tap.toolCalls,
        finishReason: tap.finishReason,
        error: tap.error,
        conversationId: (json.conversation_id ?? json.conversationId) as string | undefined,
        agentId: (json.agent_id ?? json.agentId) as string | undefined,
        ...tap.usage,
      })
    }

    this.forward(req, res, headers, body, {
      onResponse: (code, headers) => {
        httpStatus = code
        if (code >= 400) status = 'error'
        tap.setEncoding(headers['content-encoding'] as string | undefined)
      },
      onData: (chunk) => tap.push(chunk),
      onEnd: () => void tap.end().then(finish),
      onAbort: () => {
        status = 'aborted'
        void tap.end().then(finish)
      },
    })
  }

  // --- pass-through --------------------------------------------------------

  private passthrough(req: http.IncomingMessage, res: http.ServerResponse, preread?: Buffer): void {
    this.forward(req, res, forwardHeaders(req.headers, ''), preread)
  }

  private forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    headers: http.OutgoingHttpHeaders,
    body?: Buffer,
    hooks: { onResponse?(code: number, headers: http.IncomingHttpHeaders): void; onData?(c: Buffer): void; onEnd?(): void; onAbort?(): void } = {},
  ): void {
    let up: URL
    try {
      up = validateUpstreamGateway(this.deps.upstream())
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(e instanceof Error ? e.message : 'invalid upstream gateway')
      hooks.onAbort?.()
      return
    }
    headers.host = up.host
    const mod = up.protocol === 'http:' ? http : https
    const preq = mod.request(
      {
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port || (up.protocol === 'http:' ? 80 : 443),
        method: req.method,
        path: req.url,
        headers,
        agent: up.protocol === 'https:' ? this.agent : undefined,
      },
      (pres) => {
        hooks.onResponse?.(pres.statusCode ?? 502, pres.headers)
        res.writeHead(pres.statusCode ?? 502, pres.statusMessage, responseHeaders(pres.headers))
        res.flushHeaders()
        pres.on('data', (c: Buffer) => {
          hooks.onData?.(c)
          res.write(c)
        })
        pres.on('end', () => {
          res.end()
          hooks.onEnd?.()
        })
        pres.on('error', () => res.destroy())
      },
    )
    let done = false
    res.on('close', () => {
      if (!res.writableFinished && !done) {
        done = true
        preq.destroy()
        hooks.onAbort?.()
      }
    })
    res.on('finish', () => (done = true))
    preq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`[Accio BYOK] upstream error: ${err.message}`)
      } else {
        res.destroy()
      }
      if (!done) {
        done = true
        hooks.onAbort?.()
      }
    })
    if (body) preq.end(body)
    else req.pipe(preq)
  }

  private upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    if (!this.trustedLocalRequest(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    let up: URL
    try {
      up = validateUpstreamGateway(this.deps.upstream())
    } catch {
      socket.destroy()
      return
    }
    const secure = up.protocol === 'https:'
    const port = Number(up.port || (secure ? 443 : 80))
    const onConnect = () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]
        lines.push(`${k}: ${k.toLowerCase() === 'host' ? up.host : req.rawHeaders[i + 1]}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    }
    const upstream = secure
      ? tls.connect({ host: up.hostname, port, servername: up.hostname }, onConnect)
      : net.connect({ host: up.hostname, port }, onConnect)
    const kill = () => {
      upstream.destroy()
      socket.destroy()
    }
    upstream.on('error', kill)
    socket.on('error', kill)
  }
}
