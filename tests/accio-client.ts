// Mirror of Accio 0.33's client-side frame handling (gateway-worker.js: Vr, tt.fromJSON,
// streamChatNormalized, aEt). Used to verify that our SSE output is consumed as intended.

export interface ConsumedTurn {
  text: string
  reasoning: string
  thoughtParts: { text: string; thoughtSignature: string }[]
  textThoughtSignature?: string
  toolCalls: { id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }[]
  finishReason?: string
  usage?: Record<string, number>
  turnComplete: boolean
  errors: string[]
  skippedIncompleteCalls: number
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

function isProtoFrame(e: Record<string, unknown>): boolean {
  if (has(e, 'raw_response_json') || has(e, 'rawResponseJson')) return true
  return [has(e, 'content'), has(e, 'turnComplete'), has(e, 'finishReason'), has(e, 'usage')].filter(Boolean).length >= 2
}

const pick = (o: any, camel: string) => {
  if (!o) return undefined
  if (o[camel] !== undefined) return o[camel]
  return o[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]
}

export function consume(sse: string): ConsumedTurn {
  const out: ConsumedTurn = { text: '', reasoning: '', thoughtParts: [], toolCalls: [], turnComplete: false, errors: [], skippedIncompleteCalls: 0 }
  const seenIds = new Set<string>()
  const events = sse
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data:'))
    .map((b) => b.slice(5).trim())
    .filter((d) => d !== '[DONE]')
  for (const data of events) {
    const raw = JSON.parse(data)
    if (!isProtoFrame(raw)) {
      out.errors.push(`gateway_passthrough: ${data}`)
      continue
    }
    const content = pick(raw, 'content')
    const parts: any[] = content?.parts ?? []
    const turnComplete = Boolean(pick(raw, 'turnComplete') ?? false)
    const errorCode = pick(raw, 'errorCode') ?? ''
    const errorMessage = pick(raw, 'errorMessage') ?? ''
    if (errorCode || errorMessage) {
      out.errors.push(`${errorCode}: ${errorMessage}`)
      continue
    }
    const fc = (p: any) => pick(p, 'functionCall')
    if (turnComplete === false && parts.some((p) => fc(p))) {
      out.skippedIncompleteCalls++
      continue
    }
    for (const p of parts) {
      const text = pick(p, 'text')
      const sig = pick(p, 'thoughtSignature')
      if (typeof text === 'string' && text.length > 0) {
        if (pick(p, 'thought')) {
          out.reasoning += text
          if (sig) out.thoughtParts.push({ text, thoughtSignature: sig })
        } else {
          out.text += text
          if (sig) out.textThoughtSignature = sig
        }
      }
      const call = fc(p)
      if (call) {
        const id = pick(call, 'id') || `gen-${out.toolCalls.length}`
        if (seenIds.has(id)) continue
        seenIds.add(id)
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(pick(call, 'argsJson') || '{}')
        } catch {
          /* argumentsParseError */
        }
        out.toolCalls.push({ id, name: pick(call, 'name') ?? '', arguments: args, thoughtSignature: sig ?? pick(call, 'thoughtSignature') })
      }
    }
    if (turnComplete) {
      out.turnComplete = true
      out.finishReason = pick(raw, 'finishReason')
      out.usage = pick(raw, 'usageMetadata')
    }
  }
  return out
}

/** Build the assistant history message Accio would send back on the next turn (nEt). */
export function replayAssistant(turn: ConsumedTurn): { role: string; parts: Record<string, unknown>[] } {
  const parts: Record<string, unknown>[] = []
  if (turn.thoughtParts.length) for (const t of turn.thoughtParts) parts.push({ text: t.text, thought: true, thought_signature: t.thoughtSignature })
  else if (turn.reasoning) parts.push({ text: turn.reasoning, thought: true })
  const content = turn.text.trim()
  if (content) parts.push({ text: content, thought: false, ...(turn.textThoughtSignature ? { thought_signature: turn.textThoughtSignature } : {}) })
  for (const c of turn.toolCalls) {
    parts.push({
      thought: false,
      ...(c.thoughtSignature ? { thought_signature: c.thoughtSignature } : {}),
      function_call: { id: c.id.replace(/[^a-zA-Z0-9_-]/g, '_'), name: c.name, args_json: JSON.stringify(c.arguments), ...(c.thoughtSignature ? { thought_signature: c.thoughtSignature } : {}) },
    })
  }
  return { role: 'model', parts }
}

export function sseResponse(events: (string | object)[], status = 200): Response {
  const body = events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`)).join('')
  // Split into small chunks to exercise the SSE parser's buffering.
  const bytes = new TextEncoder().encode(body)
  let offset = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      const size = 7 + (offset % 13)
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}
