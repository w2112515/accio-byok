import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Provider } from '../src/shared/types.ts'
import { parseAccioRequest, stripWrappedSignatures, unwrapSignature, wrapSignature } from '../src/main/proxy/accio.ts'
import { buildAnthropicRequest } from '../src/main/proxy/adapters/anthropic.ts'
import { ThinkTagSplitter } from '../src/main/proxy/adapters/common.ts'
import { buildGeminiBody } from '../src/main/proxy/adapters/gemini.ts'
import { buildOpenAIBody, repairToolPairs } from '../src/main/proxy/adapters/openai.ts'
import { buildResponsesBody } from '../src/main/proxy/adapters/responses.ts'
import { streamByok } from '../src/main/proxy/byok.ts'
import { consume, replayAssistant, sseResponse } from './accio-client.ts'

function provider(kind: Provider['kind'], extra: Partial<Provider> = {}): Provider {
  return {
    id: `p_${kind}`,
    name: `Test ${kind}`,
    kind,
    baseUrl: kind === 'anthropic' ? 'https://api.anthropic.com' : kind === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'target-model',
    modelOverrides: {},
    createdAt: 0,
    ...extra,
  }
}

/** Shape Accio actually sends: ce() → ts-proto toJSON → snake_case keys. */
const accioBody = {
  model: '1Helix-3EjR3WN1dY6s',
  request_id: 'llm-1',
  contents: [
    { role: 'user', parts: [{ text: '帮我查一下天气', thought: false }] },
    {
      role: 'model',
      parts: [
        { text: 'thinking...', thought: true },
        { thought: false, function_call: { id: 'call_1', name: 'get_weather', args_json: '{"city":"杭州"}' } },
      ],
    },
    {
      role: 'user',
      parts: [{ thought: false, function_response: { id: 'call_1', name: 'get_weather', response_json: '{"result":"晴 25°C"}' } }],
    },
    { role: 'user', parts: [{ text: 'Visual output from tool' }, { thought: false, inline_data: { mime_type: 'image/png', data: 'iVBORw0KGgo=' } }] },
  ],
  system_instruction: 'You are Accio.',
  tools: [{ name: 'get_weather', description: 'Weather', parameters_json: '{"type":"object","properties":{"city":{"type":"string"}}}' }],
  temperature: 0.7,
  max_output_tokens: 16384,
  include_thoughts: true,
  properties: { normalized_response: 'true', reasoning_effort: 'high' },
  token: 'accio-token',
}

describe('Responses adapter', () => {
  it('round-trips encrypted reasoning, image input and tool results through Accio without storing server state', async () => {
    const p = provider('openai', { openaiApi: 'responses' })
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-cipher', summary: [{ type: 'summary_text', text: 'checking' }] }
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_2', name: 'get_weather', arguments: '{"city":"深圳"}', status: 'completed' }
    const events = [
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'checking' },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"city":"深圳"}' },
      { type: 'response.output_item.done', output_index: 1, item: call },
      { type: 'response.completed', response: { status: 'completed', output: [reasoning, call], usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } } } },
    ]
    let output = ''
    let sent: any
    const result = await streamByok({ req: parseAccioRequest(accioBody), provider: p, model: p.model, fetch: async (url, init) => {
      assert.equal(url, 'https://api.example.com/v1/responses')
      sent = JSON.parse(String(init.body))
      return sseResponse(events)
    }, signal: new AbortController().signal, write: (s) => { output += s } })
    assert.equal(result.status, 'ok')
    assert.equal(sent.store, false)
    assert.equal(sent.stream, true)
    assert.equal(sent.tools[0].strict, false)
    assert.ok(sent.input.some((item: any) => item.content?.some?.((part: any) => part.type === 'input_image')))
    assert.equal(sent.previous_response_id, undefined)
    const turn = consume(output)
    assert.equal(turn.toolCalls.length, 1)
    assert.deepEqual(turn.toolCalls[0].arguments, { city: '深圳' })
    assert.equal(turn.reasoning.replace(/\u200b/g, ''), 'checking')
    const nextReq = parseAccioRequest({ ...accioBody, contents: [accioBody.contents[0], replayAssistant(turn), { role: 'user', parts: [{ function_response: { id: 'call_2', name: 'get_weather', response_json: '{"result":"晴"}' } }] }] })
    const next = buildResponsesBody(nextReq, { provider: p, model: p.model })
    assert.equal(next.input.filter((item: any) => item.type === 'reasoning').length, 1)
    assert.equal(next.input.find((item: any) => item.type === 'function_call_output').call_id, 'call_2')
    const textHistory = buildResponsesBody(parseAccioRequest({ contents: [{ role: 'model', parts: [{ text: 'Earlier answer' }] }, { role: 'user', parts: [{ text: 'Continue' }] }] }), { provider: p, model: p.model })
    assert.deepEqual(textHistory.input[0], { role: 'assistant', content: 'Earlier answer' })
    for (const changed of [{ provider: { ...p, apiKey: 'changed' }, model: p.model }, { provider: p, model: 'another-model' }, { provider: { ...p, baseUrl: 'https://other.example/v1' }, model: p.model }]) {
      assert.equal(buildResponsesBody(nextReq, changed).input.some((item: any) => item.type === 'reasoning'), false)
    }
  })

  it('does not release tool calls on truncation, malformed arguments or missing completion', async () => {
    const p = provider('openai', { openaiApi: 'responses' })
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":' }
    for (const terminal of [undefined, { type: 'response.incomplete', response: { status: 'incomplete', output: [call], incomplete_details: { reason: 'max_output_tokens' } } }, { type: 'response.completed', response: { status: 'completed', output: [call] } }]) {
      let output = ''
      const result = await streamByok({ req: parseAccioRequest(accioBody), provider: p, model: p.model, fetch: async () => sseResponse([{ type: 'response.output_item.done', output_index: 0, item: call }, ...(terminal ? [terminal] : [])]), signal: new AbortController().signal, write: (s) => { output += s } })
      assert.equal(result.status, 'error')
      assert.equal(consume(output).toolCalls.length, 0)
      assert.equal(consume(output).turnComplete, false)
    }
  })
})

describe('request parsing', () => {
  it('normalises snake_case Accio requests', () => {
    const r = parseAccioRequest(accioBody)
    assert.equal(r.model, '1Helix-3EjR3WN1dY6s')
    assert.equal(r.systemInstruction, 'You are Accio.')
    assert.equal(r.reasoningEffort, 'high')
    assert.equal(r.maxOutputTokens, 16384)
    assert.equal(r.tools[0].parameters.type, 'object')
    assert.equal(r.contents[1].parts[1].functionCall?.name, 'get_weather')
    assert.equal(r.contents[2].parts[0].functionResponse?.responseJson, '{"result":"晴 25°C"}')
    assert.equal(r.contents[3].parts[1].inlineData?.mimeType, 'image/png')
  })

  it('namespaces signatures per provider', () => {
    const w = wrapSignature('abc', 'SIG==')!
    assert.equal(unwrapSignature('abc', w), 'SIG==')
    assert.equal(unwrapSignature('other', w), undefined)
    assert.equal(unwrapSignature('abc', 'raw-official-signature'), undefined)
    const stripped = stripWrappedSignatures({ contents: [{ parts: [{ thought_signature: w, text: 'x' }, { thought_signature: 'keep' }] }] }) as any
    assert.equal(stripped.contents[0].parts[0].thought_signature, undefined)
    assert.equal(stripped.contents[0].parts[1].thought_signature, 'keep')
  })
})

describe('OpenAI adapter', () => {
  it('builds a valid chat completions body', () => {
    const p = provider('openai', { sendReasoningContent: true, sendSampling: true })
    const body = buildOpenAIBody(parseAccioRequest(accioBody), { provider: p, model: 'gpt-x' }) as any
    const roles = body.messages.map((m: any) => m.role)
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'user'])
    assert.equal(body.messages[2].tool_calls[0].function.arguments, '{"city":"杭州"}')
    assert.equal(body.messages[2].reasoning_content, 'thinking...')
    assert.equal(body.messages[3].content, '晴 25°C')
    assert.equal(body.messages[4].content[1].image_url.url, 'data:image/png;base64,iVBORw0KGgo=')
    assert.equal(body.max_tokens, 16384)
    assert.equal(body.temperature, 0.7)
    assert.equal(body.tools[0].function.parameters.properties.city.type, 'string')
  })

  it('repairs missing and orphan tool messages', () => {
    const out = repairToolPairs([
      { role: 'assistant', content: null, tool_calls: [{ id: 'a' }, { id: 'b' }] },
      { role: 'tool', tool_call_id: 'a', content: 'A' },
      { role: 'user', content: 'next' },
      { role: 'tool', tool_call_id: 'zzz', content: 'orphan' },
    ])
    assert.deepEqual(
      out.map((m) => [m.role, m.tool_call_id ?? '']),
      [['assistant', ''], ['tool', 'a'], ['tool', 'b'], ['user', ''], ['user', '']],
    )
  })

  it('streams text, reasoning and tool calls in the shape Accio consumes', async () => {
    const upstream = [
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先想' } }] },
      { choices: [{ index: 0, delta: { reasoning_content: '一想' } }] },
      { choices: [{ index: 0, delta: { content: '好的，' } }] },
      { choices: [{ index: 0, delta: { content: '我来查。' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"上海"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } },
      'data: [DONE]\n\n',
    ]
    let sent: any
    let out = ''
    const result = await streamByok({
      req: parseAccioRequest(accioBody),
      provider: provider('openai'),
      model: 'gpt-x',
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init.body))
        return sseResponse(upstream)
      },
      signal: new AbortController().signal,
      write: (c) => (out += c),
    })
    assert.equal(result.status, 'ok')
    assert.equal(sent.stream, true)
    const turn = consume(out)
    assert.deepEqual(turn.errors, [])
    assert.equal(turn.reasoning, '先想一想')
    assert.equal(turn.text, '好的，我来查。')
    assert.equal(turn.toolCalls.length, 1)
    assert.deepEqual(turn.toolCalls[0].arguments, { city: '上海' })
    assert.equal(turn.turnComplete, true)
    assert.equal(turn.finishReason, 'STOP')
    assert.equal(turn.usage?.promptTokenCount, 120)
    assert.equal(turn.usage?.cachedContentTokenCount, 100)
    assert.equal(result.usage.outputTokens, 30)
  })

  it('reports upstream failures as an Accio error frame', async () => {
    let out = ''
    const result = await streamByok({
      req: parseAccioRequest(accioBody),
      provider: provider('openai'),
      model: 'gpt-x',
      fetch: async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 }),
      signal: new AbortController().signal,
      write: (c) => (out += c),
    })
    assert.equal(result.status, 'error')
    const turn = consume(out)
    assert.equal(turn.errors.length, 1)
    assert.match(turn.errors[0], /^401: .*Incorrect API key/)
  })

  it('keeps reasoning out of utility calls that did not ask for it', async () => {
    let out = ''
    await streamByok({
      req: parseAccioRequest({ model: 'x', contents: [{ role: 'user', parts: [{ text: '给这段对话起个标题' }] }] }),
      provider: provider('openai'),
      model: 'm',
      fetch: async () => sseResponse([{ choices: [{ delta: { reasoning_content: '想一想' } }] }, { choices: [{ delta: { content: '天气查询' } }] }, 'data: [DONE]\n\n']),
      signal: new AbortController().signal,
      write: (c) => (out += c),
    })
    const turn = consume(out)
    assert.equal(turn.reasoning, '')
    assert.equal(turn.text, '天气查询')
  })

  it('splits inline <think> tags', () => {
    const s = new ThinkTagSplitter()
    const evs = [...s.push('  <thi'), ...s.push('nk>abc'), ...s.push('def</th'), ...s.push('ink>\n\nhello'), ...s.push(' world'), ...s.flush()]
    const thought = evs.filter((e) => e.type === 'thought').map((e) => (e as any).text).join('')
    const text = evs.filter((e) => e.type === 'text').map((e) => (e as any).text).join('')
    assert.equal(thought, 'abcdef')
    assert.equal(text, 'hello world')
  })

  it('rejects incomplete streams and malformed tool arguments instead of executing a partial call', async () => {
    for (const events of [
      [],
      [{ choices: [{ delta: { content: 'partial' } }] }],
      [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write_file', arguments: '{"path":' } }] }, finish_reason: 'length' }] }],
    ]) {
      let output = ''
      const result = await streamByok({ req: parseAccioRequest({}), provider: provider('openai'), model: 'm', fetch: async () => sseResponse(events), signal: new AbortController().signal, write: (s) => { output += s } })
      assert.equal(result.status, 'error')
      assert.equal(consume(output).turnComplete, false)
      assert.equal(consume(output).toolCalls.length, 0)
    }
  })

  it('does not mark an aborted response as completed', async () => {
    const controller = new AbortController()
    let output = ''
    const result = await streamByok({
      req: parseAccioRequest({}), provider: provider('openai'), model: 'm', signal: controller.signal,
      fetch: async () => sseResponse([{ choices: [{ delta: { content: 'partial' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]),
      write: (s) => { output += s; controller.abort() },
    })
    assert.equal(result.status, 'aborted')
    assert.equal(consume(output).turnComplete, false)
  })
})

describe('Anthropic adapter', () => {
  const p = provider('anthropic', { thinking: 'adaptive', promptCaching: true, sendReasoningEffort: true })

  it('builds messages with tool pairing, caching and binding controls', () => {
    const { body, betas } = buildAnthropicRequest(parseAccioRequest(accioBody), { provider: p, model: 'claude-opus-5-5' }) as any
    assert.deepEqual(betas, ['thinking-binding-controls-2026-08-01'])
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } })
    assert.deepEqual(body.output_config, { effort: 'high' })
    assert.equal(body.temperature, undefined)
    assert.deepEqual(body.cache_control, { type: 'ephemeral' })
    assert.equal(body.system[0].cache_control.type, 'ephemeral')
    const roles = body.messages.map((m: any) => m.role)
    assert.deepEqual(roles, ['user', 'assistant', 'user'])
    // unsigned thought from another backend is not replayed
    assert.deepEqual(body.messages[1].content.map((b: any) => b.type), ['tool_use'])
    assert.equal(body.messages[2].content[0].type, 'tool_result')
    assert.equal(body.messages[2].content[0].content, '晴 25°C')
    assert.equal(body.messages[2].content[2].type, 'image')
  })

  it('round-trips a signed thinking block through Accio', async () => {
    const upstream = [
      'event: message_start\n',
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 20, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"北京"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 0, output_tokens: 42 } },
      { type: 'message_stop' },
    ]
    let out = ''
    let headers: Record<string, string> = {}
    const result = await streamByok({
      req: parseAccioRequest({ model: 'x', include_thoughts: true, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      provider: p,
      model: 'claude-opus-5-5',
      fetch: async (_u, init) => {
        headers = init.headers as Record<string, string>
        return sseResponse(upstream)
      },
      signal: new AbortController().signal,
      write: (c) => (out += c),
    })
    assert.equal(result.status, 'ok')
    assert.equal(headers['x-api-key'], 'sk-test')
    assert.equal(headers['anthropic-beta'], 'thinking-binding-controls-2026-08-01')
    const turn = consume(out)
    assert.deepEqual(turn.errors, [])
    assert.equal(turn.reasoning, 'Let me check.')
    assert.equal(turn.thoughtParts.length, 1)
    assert.equal(turn.text, 'Checking.')
    assert.deepEqual(turn.toolCalls[0].arguments, { city: '北京' })
    assert.equal(turn.usage?.promptTokenCount, 110)
    assert.equal(result.usage.cacheWriteTokens, 20)
    assert.equal(turn.usage?.candidatesTokenCount, 42)

    // Next turn: Accio replays the assistant message; the thinking block must come back intact.
    const next = parseAccioRequest({
      model: 'x',
      contents: [
        { role: 'user', parts: [{ text: 'hi' }] },
        replayAssistant(turn),
        { role: 'user', parts: [{ function_response: { id: 'toolu_1', name: 'get_weather', response_json: '{"result":"晴"}' } }] },
      ],
    })
    const { body } = buildAnthropicRequest(next, { provider: p, model: 'claude-opus-5-5' }) as any
    const assistant = body.messages[1]
    assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'Let me check.', signature: 'SIG123' })
    assert.equal(assistant.content[2].type, 'tool_use')
    assert.equal(assistant.content[2].id, 'toolu_1')
    // Another provider must never receive this signature.
    const other = buildAnthropicRequest(next, { provider: { ...p, id: 'someone-else' }, model: 'm' }).body as any
    assert.ok(!JSON.stringify(other).includes('SIG123'))
    for (const changed of [{ ...p, baseUrl: 'https://other.example' }, { ...p, apiKey: 'other-key' }, { ...p, extraHeaders: { 'X-Relay-Key': 'changed' } }, { ...p, kind: 'gemini' as const }]) {
      assert.ok(!JSON.stringify(buildAnthropicRequest(next, { provider: changed, model: 'claude-opus-5-5' }).body).includes('SIG123'))
    }
    assert.ok(!JSON.stringify(buildAnthropicRequest(next, { provider: p, model: 'other-model' }).body).includes('SIG123'))
  })

  it('drops forced tool choice and sampling params for current models', () => {
    const req = parseAccioRequest({ ...accioBody, tool_choice: 'required' })
    const { body } = buildAnthropicRequest(req, { provider: provider('anthropic', { sendSampling: true, thinking: 'off' }), model: 'm' }) as any
    assert.deepEqual(body.tool_choice, { type: 'auto' })
    assert.equal(body.temperature, 0.7)
  })
})

describe('Gemini adapter', () => {
  const p = provider('gemini', { sendReasoningEffort: true })

  it('uses the skip sentinel for function calls from other backends', () => {
    const body = buildGeminiBody(parseAccioRequest(accioBody), { provider: p, model: 'gemini-x' }) as any
    const modelTurn = body.contents.find((c: any) => c.role === 'model')
    assert.equal(modelTurn.parts[0].functionCall.name, 'get_weather')
    assert.equal(modelTurn.parts[0].thoughtSignature, 'skip_thought_signature_validator')
    const fr = body.contents[2].parts[0].functionResponse
    assert.deepEqual(fr.response, { result: '晴 25°C' })
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'high')
    assert.ok(body.tools[0].functionDeclarations[0].parametersJsonSchema)
  })

  it('carries Gemini signatures through Accio and back', async () => {
    const upstream = [
      { candidates: [{ content: { role: 'model', parts: [{ text: '思考中', thought: true }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: '我查一下' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '深圳' } }, thoughtSignature: 'GSIG' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 5 } },
    ]
    let out = ''
    let url = ''
    await streamByok({
      req: parseAccioRequest({ model: 'x', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      provider: p,
      model: 'gemini-x',
      fetch: async (u) => {
        url = u
        return sseResponse(upstream)
      },
      signal: new AbortController().signal,
      write: (c) => (out += c),
    })
    assert.match(url, /v1beta\/models\/gemini-x:streamGenerateContent\?alt=sse$/)
    const turn = consume(out)
    assert.deepEqual(turn.errors, [])
    assert.equal(turn.text, '我查一下')
    assert.equal(turn.toolCalls[0].name, 'get_weather')
    assert.equal(turn.usage?.candidatesTokenCount, 15)
    const next = parseAccioRequest({ model: 'x', contents: [{ role: 'user', parts: [{ text: 'hi' }] }, replayAssistant(turn)] })
    const body = buildGeminiBody(next, { provider: p, model: 'gemini-x' }) as any
    const call = body.contents[1].parts.find((x: any) => x.functionCall)
    assert.equal(call.thoughtSignature, 'GSIG')
    for (const changed of [{ ...p, baseUrl: 'https://other.example' }, { ...p, apiKey: 'other-key' }, { ...p, extraHeaders: { 'X-Relay-Key': 'changed' } }, { ...p, kind: 'anthropic' as const }]) {
      assert.ok(!JSON.stringify(buildGeminiBody(next, { provider: changed, model: 'gemini-x' })).includes('GSIG'))
    }
    assert.ok(!JSON.stringify(buildGeminiBody(next, { provider: p, model: 'other-model' })).includes('GSIG'))
  })
})

describe('completion boundary', () => {
  it('withholds syntactically valid tool calls when upstream stops for a limit or policy', async () => {
    for (const terminal of ['length', 'content_filter']) {
      const cases: [Provider['kind'], object[]][] = [
        ['openai', [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: terminal }] }]],
        ['anthropic', [{ type: 'message_start', message: { usage: {} } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: terminal === 'length' ? 'max_tokens' : 'refusal' } }, { type: 'message_stop' }]],
        ['gemini', [{ candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: {} } }] }, finishReason: terminal === 'length' ? 'MAX_TOKENS' : 'SAFETY' }] }]],
      ]
      for (const [kind, events] of cases) {
        const p = provider(kind)
        let output = ''
        const result = await streamByok({ req: parseAccioRequest(accioBody), provider: p, model: p.model, fetch: async () => sseResponse(events), signal: new AbortController().signal, write: (s) => { output += s } })
        assert.equal(result.status, 'error', `${kind} ${terminal}`)
        assert.equal(result.toolCalls, 0)
        assert.equal(consume(output).toolCalls.length, 0)
        assert.equal(consume(output).turnComplete, false)
      }
    }
  })

  it('reports empty and thought-only output as failure without another upstream call', async () => {
    const cases: [Provider, object[]][] = [
      [provider('openai'), [{ choices: [{ delta: { content: ' \u200b', reasoning_content: 'thinking only' }, finish_reason: 'stop' }] }]],
      [provider('openai', { openaiApi: 'responses' }), [{ type: 'response.completed', response: { status: 'completed', output: [] } }]],
      [provider('anthropic'), [{ type: 'message_start', message: { usage: {} } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]],
      [provider('gemini'), [{ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }]],
    ]
    for (const [p, events] of cases) {
      let output = '', sent = 0
      const result = await streamByok({ req: parseAccioRequest(accioBody), provider: p, model: p.model, fetch: async () => { sent++; return sseResponse(events) }, signal: new AbortController().signal, write: (s) => { output += s } })
      assert.equal(result.status, 'error', p.kind)
      assert.match(result.error!, /空结果/)
      assert.equal(consume(output).turnComplete, false)
      assert.equal(sent, 1)
    }
  })
})
