import type { ProviderInput, ProviderKind } from './types.ts'

export function validateUpstreamGateway(value: string, allowLegacyHttp = false): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('官方网关地址无效') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('官方网关必须是有效的 HTTP 或 HTTPS 地址，不能包含凭据或查询参数')
  if (!allowLegacyHttp && url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('上游网关会接收 Accio 登录凭据和同步数据，远程地址必须使用 HTTPS；HTTP 仅限本机调试')
  return url
}

/** Accept a base URL or the full endpoint copied from a provider's documentation. */
export function normalizeBaseUrl(kind: ProviderKind, value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('请输入完整的 http:// 或 https:// 接口地址') }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('接口地址仅支持 HTTP 或 HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址不能包含账号、密码、查询参数或 #；请将 Key 填入 API Key')
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
  if (!['openai', 'anthropic', 'gemini'].includes(input.kind)) throw new Error('请选择有效的接口类型')
  const baseUrl = normalizeBaseUrl(input.kind, input.baseUrl)
  const url = new URL(baseUrl)
  if (input.allowInsecureHttp !== undefined && typeof input.allowInsecureHttp !== 'boolean') throw new Error('远程 HTTP 许可必须是明确的开关值')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && input.allowInsecureHttp !== true) throw new Error('远程 HTTP 会明文传输 Key 和会话。请使用 HTTPS，或在高级设置中明确允许不安全的 HTTP')
  if (input.openaiApi !== undefined && !['chat', 'responses'].includes(input.openaiApi)) throw new Error('OpenAI 接口协议无效')
  const endpoint = new URL(input.baseUrl).pathname
  const openaiApi = input.kind === 'openai' && /\/responses\/?$/.test(endpoint) ? 'responses' : input.kind === 'openai' && /\/chat\/completions\/?$/.test(endpoint) ? 'chat' : input.openaiApi
  const model = input.model.trim()
  if (requireModel && !model) throw new Error('请填写或选择默认模型')
  for (const [label, value, min] of [
    ['最大输出 Token', input.maxOutputTokens, 1],
    ['思考预算 Token', input.thinkingBudget, 1024],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min)) throw new Error(`${label} 必须是至少 ${min} 的整数`)
  }
  for (const value of Object.values(input.pricing ?? {})) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('价格必须是大于或等于 0 的数字')
  }
  if (input.modelInfo) {
    const info = input.modelInfo
    if (info.model !== model || !['official', 'api', 'user'].includes(info.source) || !Number.isFinite(info.checkedAt)) throw new Error('模型信息已过期，请重新读取或填写当前模型的信息')
    for (const value of [info.contextWindow, info.maxOutputTokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('模型窗口和输出上限必须是正整数')
    }
  }
  if (input.extraHeaders && (typeof input.extraHeaders !== 'object' || Array.isArray(input.extraHeaders))) throw new Error('自定义请求头必须是名称和值的对象')
  for (const [name, value] of Object.entries(input.extraHeaders ?? {})) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('自定义请求头格式无效')
    if (/^(host|content-length|transfer-encoding|connection|upgrade|proxy-.*|sec-.*|cookie|set-cookie)$/i.test(name)) throw new Error(`不能覆盖请求头 ${name}；此处仅填写网关 API 请求头，不接受网站登录 Cookie`)
  }
  return {
    ...input, baseUrl, openaiApi, model, name: input.name.trim(), apiKey: input.apiKey?.trim(),
    modelOverrides: Object.fromEntries(Object.entries(input.modelOverrides ?? {}).filter(([k, v]) => k.trim() && v.trim()).map(([k, v]) => [k.trim(), v.trim()])),
  }
}
