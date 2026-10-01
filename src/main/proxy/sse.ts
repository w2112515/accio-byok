export interface SseEvent {
  event: string
  data: string
}

/** Parse a text/event-stream body into events. Tolerates CRLF and multi-line data. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  signal?.throwIfAborted()
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event = ''
  let data: string[] = []
  let dataSize = 0
  const limit = 16 * 1024 * 1024
  const onAbort = () => reader.cancel().catch(() => {})
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length + dataSize > limit) throw new Error('上游单个流式事件过大，已停止本轮请求')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          if (data.length > 0 || event) yield { event: event || 'message', data: data.join('\n') }
          event = ''
          data = []
          dataSize = 0
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let val = colon < 0 ? '' : line.slice(colon + 1)
        if (val.startsWith(' ')) val = val.slice(1)
        if (field === 'data') { data.push(val); dataSize += val.length }
        else if (field === 'event') event = val
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
        else if (line.startsWith('event:')) event = line.slice(6).trim()
      }
    }
    if (data.length > 0) yield { event: event || 'message', data: data.join('\n') }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
