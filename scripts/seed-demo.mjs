// Seeds a throwaway user-data directory with demo providers and request logs (for screenshots).
// Usage: node scripts/seed-demo.mjs <dir>
import fs from 'node:fs'
import path from 'node:path'

const target = process.argv[2]
if (!target) throw new Error('usage: seed-demo.mjs <new-directory>')
const dir = path.resolve(target)
// Always reserve a new directory. Never remove or overwrite an existing target.
fs.mkdirSync(path.dirname(dir), { recursive: true })
try { fs.mkdirSync(dir) } catch (error) {
  if (error.code === 'EEXIST') throw new Error('目标路径已存在；请选择一个新的演示目录，已有内容不会被删除或覆盖')
  throw error
}
fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })

const plain = (s) => `plain:${Buffer.from(s).toString('base64')}`
const providers = [
  { id: 'pdeep', presetId: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: plain('sk-demo-deepseek-1234abcd'), model: 'deepseek-chat', modelOverrides: {}, sendReasoningContent: true, sendSampling: true, maxOutputTokens: 8192, pricing: { input: 0.28, output: 0.42, cachedInput: 0.028 }, createdAt: 1 },
  { id: 'pclaude', presetId: 'anthropic', name: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: plain('sk-ant-demo-99887766'), model: 'claude-opus-5-5', modelOverrides: { '1Nova-Q3xM8vJ1rH6z': 'claude-haiku-4-5' }, thinking: 'adaptive', promptCaching: true, sendReasoningEffort: true, maxOutputTokens: 64000, pricing: { input: 4, output: 20, cachedInput: 0.2 }, createdAt: 2 },
  { id: 'pollama', presetId: 'ollama', name: 'Ollama', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3:14b', modelOverrides: {}, sendSampling: true, createdAt: 3 },
]
fs.writeFileSync(
  path.join(dir, 'config.json'),
  JSON.stringify({ version: 1, activeProviderId: process.env.ACTIVE ?? 'pclaude', providers, settings: { proxyPort: 18931, theme: process.env.THEME ?? 'system' } }, null, 2),
)

const models = { pdeep: ['deepseek-chat'], pclaude: ['claude-opus-5-5', 'claude-haiku-4-5'], pollama: ['qwen3:14b'], official: ['1Helix-3EjR3WN1dY6s'] }
const names = { pdeep: 'DeepSeek', pclaude: 'Claude', pollama: 'Ollama', official: 'Accio 官方' }
const price = Object.fromEntries(providers.map((p) => [p.id, p.pricing]))
let seq = 0
const now = Date.now()
for (let d = 6; d >= 0; d--) {
  const day = new Date(now - d * 86400000)
  const lines = []
  const count = d === 0 ? 34 : 20 + Math.round(Math.random() * 60)
  for (let i = 0; i < count; i++) {
    const ts = d === 0 ? now - (count - i) * 90_000 : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9 + Math.floor((i / count) * 12), Math.floor(Math.random() * 60)).getTime()
    const pid = ['pclaude', 'pclaude', 'pdeep', 'pdeep', 'pdeep', 'official', 'pollama'][Math.floor(Math.random() * 7)]
    const input = 3000 + Math.round(Math.random() * 40000)
    const cached = pid === 'pclaude' || pid === 'pdeep' ? Math.round(input * (0.5 + Math.random() * 0.4)) : 0
    const output = 80 + Math.round(Math.random() * 2400)
    const err = Math.random() < 0.04
    const p = price[pid]
    const cost = p ? ((input - cached) * p.input + cached * (p.cachedInput ?? p.input) + output * p.output) / 1e6 : undefined
    const model = models[pid][Math.floor(Math.random() * models[pid].length)]
    lines.push(
      JSON.stringify({
        id: `${ts.toString(36)}-${(seq++).toString(36)}`,
        ts,
        mode: pid === 'official' ? 'official' : 'byok',
        providerId: pid,
        providerName: names[pid],
        accioModel: pid === 'official' ? model : ['1Helix-3EjR3WN1dY6s', 'auto', '1Nova-Q3xM8vJ1rH6z'][i % 3],
        targetModel: model,
        status: err ? 'error' : 'ok',
        httpStatus: err ? 429 : undefined,
        durationMs: 1200 + Math.round(Math.random() * 30000),
        ttftMs: 300 + Math.round(Math.random() * 2500),
        toolCalls: Math.random() < 0.45 ? 1 + Math.floor(Math.random() * 3) : 0,
        finishReason: 'STOP',
        error: err ? `${names[pid]} 返回 429（触发限流或余额不足）：Rate limit reached` : undefined,
        inputTokens: err ? 0 : input,
        outputTokens: err ? 0 : output,
        cachedTokens: err ? 0 : cached,
        reasoningTokens: pid === 'pclaude' && !err ? Math.round(output * 0.3) : 0,
        costUsd: err ? undefined : cost,
      }),
    )
  }
  const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  fs.writeFileSync(path.join(dir, 'logs', `${key}.jsonl`), lines.join('\n') + '\n')
}
console.log('seeded', dir)
