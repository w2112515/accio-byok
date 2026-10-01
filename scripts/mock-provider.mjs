// A tiny OpenAI-compatible provider for walkthroughs. Key "sk-good" is accepted.
// POST /__mode {"mode":"ok"|"429"|"500"} switches behaviour.  Usage: node scripts/mock-provider.mjs [port]
import http from 'node:http'

const port = Number(process.argv[2] ?? 18999)
let mode = 'ok'
let requests = 0
let metadataRequests = 0
let lastGeneration

http
  .createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      if (req.url === '/__mode') {
        mode = JSON.parse(body || '{}').mode ?? 'ok'
        res.end(JSON.stringify({ mode }))
        return
      }
      if (req.url === '/__stats') { res.end(JSON.stringify({ requests, metadataRequests, lastGeneration })); return }
      const auth = req.headers.authorization ?? ''
      if (auth !== 'Bearer sk-good') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }))
        return
      }
      if (req.url?.endsWith('/models')) {
        metadataRequests++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'mock-fast', context_window: 64_000, max_output_tokens: 4096, effort: { supported_levels: ['low', 'high'] } }, { id: 'mock-pro', context_window: 128_000, max_output_tokens: 8192 }, { id: 'mock-reasoner' }] }))
        return
      }
      if (req.url?.endsWith('/chat/completions') || req.url?.endsWith('/responses')) {
        requests++
        lastGeneration = JSON.parse(body)
        if (mode !== 'ok') {
          res.writeHead(Number(mode), { 'content-type': 'application/json', ...(mode === '429' ? { 'retry-after': '3' } : {}) })
          res.end(JSON.stringify({ error: { message: mode === '429' ? 'Rate limit reached for requests' : 'Upstream overloaded' } }))
          return
        }
        const { model, tools, messages, input } = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)
        await new Promise((r) => setTimeout(r, 350))
        if (req.url.endsWith('/responses')) {
          const continued = input?.some((m) => m.type === 'function_call_output' && String(m.output).includes('violet-73'))
          const isTool = !continued && tools?.some((t) => t.name === 'connection_probe')
          const isImage = input?.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'input_image'))
          const output = isTool
            ? [{ type: 'function_call', id: 'fc_probe', call_id: 'probe_1', name: 'connection_probe', arguments: '{"value":"pong"}', status: 'completed' }]
            : [{ type: 'message', id: 'msg_probe', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: continued ? 'violet-73' : isImage ? 'red' : `你好！这是通过 Responses 接入的 ${model}。`, annotations: [] }] }]
          send({ type: 'response.output_item.done', output_index: 0, item: output[0] })
          send({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 50 } } } })
          res.end()
          return
        }
        const continued = messages?.some((m) => m.role === 'tool' && String(m.content).includes('violet-73'))
        if (!continued && tools?.some((t) => t.function?.name === 'connection_probe')) {
          send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'probe_1', type: 'function', function: { name: 'connection_probe', arguments: '{"value":"pong"}' } }] } }] })
          send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          res.end('data: [DONE]\n\n')
          return
        }
        const isImage = messages?.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))
        for (const t of continued ? ['violet-73'] : isImage ? ['red'] : ['你好！', '我是', `通过 Accio BYOK 接入的 ${model}。`]) {
          send({ choices: [{ index: 0, delta: { content: t } }] })
          await new Promise((r) => setTimeout(r, 120))
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        send({ choices: [], usage: { prompt_tokens: 1834, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 1200 } } })
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(404).end()
    })
  })
  .listen(port, '127.0.0.1', () => console.log(`mock provider on http://127.0.0.1:${port}/v1`))
