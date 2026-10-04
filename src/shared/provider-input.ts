import { tr, tx } from './i18n.ts'
import type { ProviderInput, ProviderKind } from './types.ts'
import { subscriptionRoute } from './provider-access.ts'
import { REASONING_EFFORTS } from './types.ts'
import { reasoningEffortIssue } from './model-info.ts'

export function validateUpstreamGateway(value: string, allowLegacyHttp = false): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(tr("官方网关地址无效")) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(tr("官方网关必须是有效的 HTTP 或 HTTPS 地址，不能包含凭据或查询参数"))
  if (!allowLegacyHttp && url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(tr("上游网关会接收 Accio 登录凭据和同步数据，远程地址必须使用 HTTPS；HTTP 仅限本机调试"))
  return url
}

/** Accept a base URL or the full endpoint copied from a provider's documentation. */
export function normalizeBaseUrl(kind: ProviderKind, value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error(tr("请输入完整的 http:// 或 https:// 接口地址")) }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error(tr("接口地址仅支持 HTTP 或 HTTPS"))
  if (url.username || url.password || url.search || url.hash) throw new Error(tr("接口地址不能包含账号、密码、查询参数或 #；请将 Key 填入 API Key"))
  let pathname = url.pathname.replace(/\/+$/, '')
  if (kind === 'openai') {
    pathname = pathname.replace(/\/(?:chat\/completions|responses)$/, '')
  } else if (kind === 'anthropic') pathname = pathname.replace(/\/v1(?:\/messages)?$/, '')
  else if (kind === 'gemini') pathname = pathname.replace(/\/v1(?:beta)?(?:\/models(?:\/[^/]+(?::(?:streamGenerateContent|generateContent))?)?)?$/, '')
  return `${url.origin}${pathname}`
}

/** Only infer a protocol when the hostname or endpoint provides direct evidence. */
export function inferProviderKind(value: string): ProviderKind | undefined {
  try {
    const url = new URL(value.trim())
    if (url.hostname === 'api.anthropic.com' || /\/v1\/messages\/?$/.test(url.pathname)) return 'anthropic'
    if (url.hostname === 'generativelanguage.googleapis.com' || /:streamGenerateContent$|:generateContent$/.test(url.pathname)) return 'gemini'
    if (/\/(?:chat\/completions|responses)\/?$/.test(url.pathname)) return 'openai'
  } catch { /* incomplete input */ }
  return undefined
}

export function normalizeProviderInput(input: ProviderInput, requireModel = false): ProviderInput {
  // Views and evidence are outputs, never configuration accepted back over IPC.
  const fields = new Set(['id', 'name', 'kind', 'openaiApi', 'allowInsecureHttp', 'presetId', 'authMode', 'credentialId', 'fundingSource', 'subscriptionAcknowledged', 'fallbackEligible', 'baseUrl', 'apiKey', 'model', 'modelOverrides', 'parameterMode', 'reasoningPreference', 'maxOutputTokens', 'sendReasoningEffort', 'sendReasoningContent', 'thinking', 'thinkingBudget', 'promptCaching', 'sendSampling', 'extraHeaders', 'pricing', 'pricingModel', 'pricingUpdatedAt', 'modelInfo', 'note'])
  input = Object.fromEntries(Object.entries(input).filter(([key]) => fields.has(key))) as ProviderInput
  if (!['openai', 'anthropic', 'gemini'].includes(input.kind)) throw new Error(tr("请选择有效的接口类型"))
  const baseUrl = normalizeBaseUrl(input.kind, input.baseUrl)
  const url = new URL(baseUrl)
  if (input.allowInsecureHttp !== undefined && typeof input.allowInsecureHttp !== 'boolean') throw new Error(tr("远程 HTTP 许可必须是明确的开关值"))
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && input.allowInsecureHttp !== true) throw new Error(tr("远程 HTTP 会明文传输 Key 和会话。请使用 HTTPS，或在高级设置中明确允许不安全的 HTTP"))
  if (input.openaiApi !== undefined && !['chat', 'responses'].includes(input.openaiApi)) throw new Error(tr("OpenAI 接口协议无效"))
  const endpoint = new URL(input.baseUrl).pathname
  const openaiApi = input.kind === 'openai' && /\/responses\/?$/.test(endpoint) ? 'responses' : input.kind === 'openai' && /\/chat\/completions\/?$/.test(endpoint) ? 'chat' : input.openaiApi
  const model = input.model.trim()
  if (input.parameterMode !== undefined && !['auto', 'custom'].includes(input.parameterMode)) throw new Error(tx('Invalid parameter mode', '参数模式无效'))
  if (input.reasoningPreference !== undefined && !['auto', 'fast', 'deep', ...REASONING_EFFORTS].includes(input.reasoningPreference)) throw new Error(tx('Invalid reasoning preference', '推理偏好无效'))
  const authMode = input.authMode ?? 'api-key'
  if (!['api-key', 'subscription-key', 'openai-oauth', 'openrouter-oauth', 'none'].includes(authMode)) throw new Error(tx("Invalid authentication method", "认证方式无效"))
  if (input.fundingSource && !['api', 'subscription', 'local'].includes(input.fundingSource)) throw new Error(tx("Invalid billing source", "计费来源无效"))
  if (authMode === 'none' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(tx("The local no-key mode requires a loopback endpoint", "本地无 Key 模式只允许本机回环地址"))
  if (authMode.endsWith('-oauth')) {
    const expected = authMode === 'openai-oauth' ? 'https://api.openai.com/v1' : 'https://openrouter.ai/api/v1'
    if (input.kind !== 'openai' || baseUrl !== expected || Object.keys(input.extraHeaders ?? {}).length || (authMode === 'openai-oauth' && openaiApi !== 'responses')) throw new Error(tx("OAuth credentials require the official endpoint and cannot use custom headers or another protocol", "OAuth 凭据必须使用官方地址，不能使用自定义请求头或其他协议"))
    if (!input.credentialId) throw new Error(tx("Complete sign-in before saving or testing this connection", "保存或测试此连接前请先完成登录"))
  }
  if (authMode === 'subscription-key' && input.subscriptionAcknowledged !== true) throw new Error(tx("Confirm that your planned use is permitted by this subscription before sending requests", "发送请求前，请确认使用场景符合该订阅的规则"))
  if (authMode === 'subscription-key' && (!subscriptionRoute({ ...input, baseUrl }) || input.kind !== 'openai' || openaiApi === 'responses' || Object.keys(input.extraHeaders ?? {}).length)) throw new Error(tx("Subscription keys require a supported official subscription endpoint, Chat Completions and no custom headers", "订阅 Key 需使用支持的官方订阅地址及 Chat Completions 协议，不允许自定义请求头"))
  if (requireModel && !model) throw new Error(tr("请填写或选择默认模型"))
  for (const [label, value, min] of [
    [tr("最大输出 Token"), input.maxOutputTokens, 1],
    [tr("思考预算 Token"), input.thinkingBudget, 1024],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min)) throw new Error(tr("{0} 必须是至少 {1} 的整数", label, min))
  }
  for (const value of Object.values(input.pricing ?? {})) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(tr("价格必须是大于或等于 0 的数字"))
  }
  if (input.modelInfo) {
    const info = input.modelInfo
    if (info.model !== model || !['official', 'api', 'user'].includes(info.source) || !Number.isFinite(info.checkedAt)) throw new Error(tr("模型信息已过期，请重新读取或填写当前模型的信息"))
    for (const value of [info.contextWindow, info.maxOutputTokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(tr("模型窗口和输出上限必须是正整数"))
    }
    if (info.effortLevels !== undefined && (!Array.isArray(info.effortLevels) || info.effortLevels.length > REASONING_EFFORTS.length || info.effortLevels.some((v) => !(REASONING_EFFORTS as readonly string[]).includes(v)))) throw new Error(tx('Invalid model reasoning levels', '模型推理档位无效'))
    if (info.thinking !== undefined && !['off', 'adaptive', 'budget'].includes(info.thinking)) throw new Error(tx('Invalid model thinking mode', '模型思考模式无效'))
    if (info.recommendedApi !== undefined && !['chat', 'responses'].includes(info.recommendedApi)) throw new Error(tx('Invalid model protocol', '模型协议无效'))
    for (const value of [info.sampling, info.reasoningContent, info.tools, info.vision]) {
      if (value !== undefined && typeof value !== 'boolean') throw new Error(tx('Invalid model capability', '模型能力信息无效'))
    }
  }
  if (input.extraHeaders && (typeof input.extraHeaders !== 'object' || Array.isArray(input.extraHeaders))) throw new Error(tr("自定义请求头必须是名称和值的对象"))
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(tr("自定义请求头格式无效"))
    if (/^(host|content-length|transfer-encoding|connection|upgrade|proxy-.*|sec-.*|cookie|set-cookie)$/i.test(name)) throw new Error(tr("不能覆盖请求头 {0}；此处仅填写网关 API 请求头，不接受网站登录 Cookie", name))
  }
  const normalized = {
    ...input, baseUrl, openaiApi, model, name: input.name.trim(), apiKey: input.apiKey?.trim(),
    authMode,
    fundingSource: authMode === 'openai-oauth' || authMode === 'subscription-key' ? 'subscription' : authMode === 'none' ? 'local' : 'api',
    modelOverrides: Object.fromEntries(Object.entries(input.modelOverrides ?? {}).filter(([k, v]) => k.trim() && v.trim()).map(([k, v]) => [k.trim(), v.trim()])),
  } satisfies ProviderInput
  if (requireModel) {
    for (const target of new Set([model, ...Object.values(normalized.modelOverrides)])) {
      const issue = reasoningEffortIssue(normalized, target)
      if (issue) throw new Error(issue)
    }
  }
  return normalized
}
