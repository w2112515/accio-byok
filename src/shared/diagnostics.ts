import { tx } from './i18n.ts'
import type { RequestLog } from './types.ts'

export function requestDiagnosis(log: RequestLog): { label: string; action: string } {
  if (log.notSent) return { label: tx('Local block · not sent', '本地拦截 · 未发送'), action: tx('Check the connection, sign-in or local cooldown. No inference request was sent.', '检查连接、登录状态或本地冷却；本次未发送推理请求。') }
  if (log.status === 'aborted') return { label: tx('Cancelled', '已取消'), action: tx('The client cancelled. The provider may have processed part of the request.', '客户端取消了请求，供应商可能已经处理了部分内容。') }
  if (log.errorCode === 'subscription_sharing_usage_limit_exceeded') return { label: tx('ChatGPT usage limit', 'ChatGPT 用量受限'), action: tx('Manage usage in ChatGPT settings. This may be an app-specific limit; no reset time is assumed.', '在 ChatGPT 设置中管理用量。可能是应用限额，不能据此推断套餐耗尽或重置时间。') }
  if (log.errorCode === 'subscription_sharing_user_not_eligible') return { label: tx('Plan access unavailable', '套餐访问不可用'), action: tx('Check the selected account, workspace and eligibility. Repeated sign-ins will not remove this restriction.', '检查所选账号、工作区及资格；重复登录不会消除此限制。') }
  if (log.errorCode?.includes('unsupported') || log.httpStatus === 404) return { label: tx('Model or capability mismatch', '模型或能力不匹配'), action: tx('Check the model, endpoint and supported parameters. Edit the connection before retrying.', '检查模型、地址及支持的参数，修改连接后再重试。') }
  if (/context.{0,30}(length|window|limit)|prompt.{0,20}(too long|too large)|too many tokens|上下文不足/i.test(log.error ?? '')) return { label: tx('Context limit', '上下文超限'), action: tx('Compact or start a new conversation in Accio. Switching providers does not change Accio’s native compression threshold.', '在 Accio 整理或新建会话。切换供应商不会改变 Accio 原生压缩阈值。') }
  if (log.httpStatus === 401 || log.httpStatus === 403) return { label: tx('Authentication or permission', '身份或权限'), action: tx('Check the selected account, key, region and service permissions.', '检查所选账号、Key、地区和服务权限。') }
  if (log.httpStatus === 429) return { label: tx('Rate or usage limit', '速率或用量限制'), action: tx('Check provider usage and the cooldown. No automatic billing fallback or request replay occurs.', '核对供应商用量和冷却状态；不会自动切换计费通道或重放请求。') }
  if (log.status === 'error') return { label: tx('Upstream or transport failure', '上游或传输失败'), action: tx('Use the HTTP status and request ID to investigate. If a tool ran earlier, verify its result before manually retrying.', '按 HTTP 状态和请求 ID 排查；若此前已运行工具，请先核对结果再手动重试。') }
  return { label: tx('Completed', '已完成'), action: tx('A complete response was received. This does not independently verify the quality of the task result.', '已收到完整响应；这不等于独立验证了任务结果的质量。') }
}
