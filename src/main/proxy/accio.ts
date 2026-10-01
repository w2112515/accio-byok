import { tr } from '../../shared/i18n.ts'
// Accio ADK gateway protocol, reverse-engineered from Accio 0.33 (gateway-worker.js).
//
// Request:  POST {gateway}/api/adk/llm/generateContent  (JSON, keys snake_cased from a
//           ts-proto GenerateContentRequest; may be gzip/zstd encoded)
// Response: text/event-stream, one `data: {json}` per frame. Frames must use camelCase
//           keys: the client only treats an event as a model frame when at least two of
//           `content`, `turnComplete`, `finishReason`, `usage` are present.
// Semantics: text / thought parts are deltas appended by the client. Function calls are
//           only accepted on a frame with `turnComplete: true`.

export interface AccioFunctionCall {
  id: string
  name: string
  argsJson: string
  thoughtSignature?: string
}

export interface AccioPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: AccioFunctionCall
  functionResponse?: { id: string; name: string; responseJson: string }
  inlineData?: { mimeType: string; data: string }
  fileData?: { mimeType: string; fileUri: string }
}

export interface AccioContent {
  role: string
  parts: AccioPart[]
}

export interface AccioTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Normalised view of an Accio generateContent request. */
export interface AccioRequest {
  model: string
  contents: AccioContent[]
  systemInstruction: string
  tools: AccioTool[]
  temperature?: number
  topP?: number
  maxOutputTokens?: number
  stopSequences: string[]
  includeThoughts?: boolean
  thinkingBudget?: number
  thinkingLevel?: string
  reasoningEffort?: string
  toolChoice?: string
  responseFormat?: string
  conversationId?: string
  agentId?: string
  requestId?: string
}

type Json = Record<string, unknown>

function pick(o: Json | undefined, camel: string): unknown {
  if (!o) return undefined
  if (o[camel] !== undefined) return o[camel]
  const snake = camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  return o[snake]
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)

function parsePart(raw: Json): AccioPart {
  const part: AccioPart = {}
  const text = str(pick(raw, 'text'))
  if (text !== undefined) part.text = text
  if (pick(raw, 'thought') === true) part.thought = true
  const sig = str(pick(raw, 'thoughtSignature'))
  if (sig) part.thoughtSignature = sig
  const fc = obj(pick(raw, 'functionCall'))
  if (fc) {
    part.functionCall = {
      id: str(pick(fc, 'id')) ?? '',
      name: str(pick(fc, 'name')) ?? '',
      argsJson: str(pick(fc, 'argsJson')) ?? '',
      thoughtSignature: str(pick(fc, 'thoughtSignature')) || sig,
    }
  }
  const fr = obj(pick(raw, 'functionResponse'))
  if (fr) {
    part.functionResponse = {
      id: str(pick(fr, 'id')) ?? '',
      name: str(pick(fr, 'name')) ?? '',
      responseJson: str(pick(fr, 'responseJson')) ?? '',
    }
  }
  const inline = obj(pick(raw, 'inlineData'))
  if (inline) {
    part.inlineData = { mimeType: str(pick(inline, 'mimeType')) ?? '', data: str(pick(inline, 'data')) ?? '' }
  }
  const file = obj(pick(raw, 'fileData'))
  if (file) {
    part.fileData = { mimeType: str(pick(file, 'mimeType')) ?? '', fileUri: str(pick(file, 'fileUri')) ?? '' }
  }
  return part
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return { type: 'object', properties: {} }
  try {
    const v = JSON.parse(text)
    return obj(v) ?? { type: 'object', properties: {} }
  } catch {
    return { type: 'object', properties: {} }
  }
}

export function parseAccioRequest(body: unknown): AccioRequest {
  const raw = obj(body)
  if (!raw) throw new Error(tr("请求体不是 JSON 对象"))
  const props = obj(pick(raw, 'properties')) ?? {}
  const contents = (Array.isArray(raw.contents) ? raw.contents : []).map((c): AccioContent => {
    const co = obj(c) ?? {}
    const parts = Array.isArray(co.parts) ? co.parts : []
    return { role: str(co.role) ?? 'user', parts: parts.map((p) => parsePart(obj(p) ?? {})) }
  })
  const tools = (Array.isArray(raw.tools) ? raw.tools : []).map((t): AccioTool => {
    const to = obj(t) ?? {}
    return {
      name: str(pick(to, 'name')) ?? '',
      description: str(pick(to, 'description')) ?? '',
      parameters: parseJsonObject(str(pick(to, 'parametersJson'))),
    }
  })
  const stops = pick(raw, 'stopSequences')
  return {
    model: str(raw.model) ?? '',
    contents,
    systemInstruction: str(pick(raw, 'systemInstruction')) ?? '',
    tools: tools.filter((t) => t.name),
    temperature: num(raw.temperature),
    topP: num(pick(raw, 'topP')),
    maxOutputTokens: num(pick(raw, 'maxOutputTokens')),
    stopSequences: Array.isArray(stops) ? stops.filter((s): s is string => typeof s === 'string') : [],
    includeThoughts: typeof pick(raw, 'includeThoughts') === 'boolean' ? (pick(raw, 'includeThoughts') as boolean) : undefined,
    thinkingBudget: num(pick(raw, 'thinkingBudget')),
    thinkingLevel: str(pick(raw, 'thinkingLevel')),
    // Accio moves reasoning_effort into properties for OpenAI-family models.
    reasoningEffort: str(pick(raw, 'reasoningEffort')) ?? str(props.reasoning_effort),
    toolChoice: str(pick(raw, 'toolChoice')),
    responseFormat: str(pick(raw, 'responseFormat')),
    conversationId: str(pick(raw, 'conversationId')),
    agentId: str(pick(raw, 'agentId')),
    requestId: str(pick(raw, 'requestId')),
  }
}

// ---------------------------------------------------------------------------
// Thought signatures
//
// Signatures are only valid for the provider that produced them. We namespace the ones
// we hand to Accio so a signature is never replayed to a different backend (another
// provider, or the official gateway after switching back).

const SIG_PREFIX = 'asw1:'

export function wrapSignature(providerId: string, signature: string | undefined): string | undefined {
  return signature ? `${SIG_PREFIX}${providerId}:${signature}` : undefined
}

/** Returns the raw signature if it was produced by `providerId`, otherwise undefined. */
export function unwrapSignature(providerId: string, value: string | undefined): string | undefined {
  if (!value || !value.startsWith(SIG_PREFIX)) return undefined
  const rest = value.slice(SIG_PREFIX.length)
  const i = rest.indexOf(':')
  if (i < 0) return undefined
  return rest.slice(0, i) === providerId ? rest.slice(i + 1) : undefined
}

export function containsWrappedSignature(text: string): boolean {
  return text.includes(SIG_PREFIX)
}

/** Remove our namespaced signatures from a raw request before it reaches the official gateway. */
export function stripWrappedSignatures(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripWrappedSignatures)
  const o = obj(value)
  if (!o) return value
  const out: Json = {}
  for (const [k, v] of Object.entries(o)) {
    if ((k === 'thought_signature' || k === 'thoughtSignature') && typeof v === 'string' && v.startsWith(SIG_PREFIX)) continue
    out[k] = stripWrappedSignatures(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// Adapter events → Accio frames

export interface Usage {
  /** Total prompt tokens, including cached ones. */
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheWriteTokens?: number
  reasoningTokens: number
  usageReported?: boolean
  cacheReadReported?: boolean
  cacheWriteReported?: boolean
}

export type AdapterEvent =
  | { type: 'text'; text: string; signature?: string }
  | { type: 'thought'; text: string; signature?: string }
  | { type: 'tool_call'; id: string; name: string; argsJson: string; signature?: string }
  | { type: 'finish'; reason?: string; usage?: Partial<Usage> }

export class UpstreamError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
  }
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, usageReported: false, cacheReadReported: false, cacheWriteReported: false }
}

export function textFrame(text: string, thought = false, thoughtSignature?: string): Json {
  const part: Json = { text }
  if (thought) part.thought = true
  if (thoughtSignature) part.thoughtSignature = thoughtSignature
  return { content: { role: 'model', parts: [part] }, partial: true, turnComplete: false }
}

export function finalFrame(calls: AccioFunctionCall[], finishReason: string, usage: Usage): Json {
  return {
    content: {
      role: 'model',
      parts: calls.map((c) => ({
        functionCall: {
          id: c.id,
          name: c.name,
          argsJson: c.argsJson || '{}',
          ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
        },
        ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}),
      })),
    },
    partial: false,
    turnComplete: true,
    finishReason,
    usageMetadata: {
      promptTokenCount: usage.inputTokens,
      candidatesTokenCount: usage.outputTokens,
      totalTokenCount: usage.inputTokens + usage.outputTokens,
      ...(usage.cachedTokens ? { cachedContentTokenCount: usage.cachedTokens } : {}),
      ...(usage.reasoningTokens ? { thoughtsTokenCount: usage.reasoningTokens } : {}),
    },
  }
}

export function errorFrame(message: string, code = '502'): Json {
  return {
    content: { role: 'model', parts: [] },
    partial: false,
    turnComplete: true,
    finishReason: 'OTHER',
    errorCode: code,
    errorMessage: message,
  }
}

const FINISH_MAP: Record<string, string> = {
  stop: 'STOP',
  end_turn: 'STOP',
  tool_calls: 'STOP',
  tool_use: 'STOP',
  function_call: 'STOP',
  stop_sequence: 'STOP',
  pause_turn: 'STOP',
  length: 'MAX_TOKENS',
  max_tokens: 'MAX_TOKENS',
  content_filter: 'SAFETY',
  safety: 'SAFETY',
  refusal: 'SAFETY',
}

export function normalizeFinishReason(reason: string | undefined): string {
  if (!reason) return 'STOP'
  return FINISH_MAP[reason.toLowerCase()] ?? reason.toUpperCase()
}

export function sseData(frame: unknown): string {
  return `data: ${JSON.stringify(frame)}\n\n`
}

// ---------------------------------------------------------------------------
// Helpers shared by adapters

/** Tool results arrive as JSON (`{result: ...}` when the tool returned a plain value). */
export function toolResultText(responseJson: string): string {
  if (!responseJson) return ''
  try {
    const v = JSON.parse(responseJson)
    const o = obj(v)
    if (o) {
      const keys = Object.keys(o).filter((k) => k !== '__accio_store_context')
      if (keys.length === 1 && keys[0] === 'result') {
        const r = o.result
        return typeof r === 'string' ? r : JSON.stringify(r)
      }
    }
    return typeof v === 'string' ? v : responseJson
  } catch {
    return responseJson
  }
}

export function safeToolId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned || `call_${Math.random().toString(36).slice(2, 12)}`
}

export function newToolId(): string {
  return `call_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}

export function parseArgs(argsJson: string): Record<string, unknown> {
  if (!argsJson) return {}
  try {
    return obj(JSON.parse(argsJson)) ?? {}
  } catch {
    return {}
  }
}

/** Map Accio's effort vocabulary (low…max) onto a provider's supported set. */
export function clampEffort(effort: string | undefined, allowed: readonly string[]): string | undefined {
  if (!effort) return undefined
  const e = effort.toLowerCase()
  if (allowed.includes(e)) return e
  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const idx = order.indexOf(e)
  if (idx < 0) return undefined
  for (let i = idx; i >= 0; i--) if (allowed.includes(order[i])) return order[i]
  return allowed[0]
}
