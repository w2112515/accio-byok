import { tx } from './i18n.ts'
import type { CapabilityCheck, ProviderView, RequestLog, TestScope } from './types.ts'

/** A reminder policy, not an assertion that a provider stops working after 30 days. */
export const CHECK_REVIEW_DAYS = 30

export function checkNeedsReview(check: CapabilityCheck, now = Date.now()): boolean {
  return !Number.isFinite(check.checkedAt) || now - check.checkedAt >= CHECK_REVIEW_DAYS * 86_400_000
}

export function checkScopeLabel(scope: TestScope): string {
  return { text: tx('Text', '文本'), tools: tx('Tools', '工具'), image: tx('Image', '图片'), multiturn: tx('Tool round trip', '工具多轮续接') }[scope]
}

export function matchesConnection(log: RequestLog, provider: ProviderView): boolean {
  // Old records remain in history, but cannot prove the currently saved connection works.
  return Boolean(provider.connectionFingerprint) && log.providerId === provider.id && log.connectionFingerprint === provider.connectionFingerprint
}
