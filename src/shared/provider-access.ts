import { tx } from './i18n.ts'
import type { Provider } from './types.ts'

export const ACCESS_REVIEWED_AT = '2026-10-01'
export interface SubscriptionRoute { name: string; baseUrl: string; model?: string; docsUrl: string; usageUrl: string }
export const SUBSCRIPTION_ROUTES: Record<string, SubscriptionRoute[]> = {
  moonshot: [{ name: 'Kimi Code', baseUrl: 'https://api.kimi.com/coding/v1', model: 'kimi-for-coding', docsUrl: 'https://www.kimi.com/help/kimi-code/membership-guide', usageUrl: 'https://www.kimi.com/code/console' }],
  minimax: [
    { name: 'MiniMax Token Plan · China', baseUrl: 'https://api.minimaxi.com/v1', docsUrl: 'https://platform.minimaxi.com/subscribe/coding-plan', usageUrl: 'https://platform.minimaxi.com/subscribe/coding-plan' },
    { name: 'MiniMax M Plan · International', baseUrl: 'https://api.minimax.io/v1', docsUrl: 'https://www.minimax.io/m-plan', usageUrl: 'https://platform.minimax.io/subscribe/token-plan' },
  ],
  zhipu: [{ name: 'GLM Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/others', usageUrl: 'https://open.bigmodel.cn/usercenter/subscription' }],
  dashscope: [
    { name: 'Bailian Token Plan · Beijing', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', docsUrl: 'https://help.aliyun.com/zh/model-studio/more-tools', usageUrl: 'https://bailian.console.aliyun.com/' },
    { name: 'Bailian Coding Plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', docsUrl: 'https://help.aliyun.com/zh/model-studio/more-tools', usageUrl: 'https://bailian.console.aliyun.com/' },
  ],
}

export function subscriptionRoute(p: Pick<Provider, 'presetId' | 'baseUrl'>): SubscriptionRoute | undefined {
  return SUBSCRIPTION_ROUTES[p.presetId ?? '']?.find((r) => r.baseUrl === p.baseUrl.replace(/\/+$/, ''))
}

export function fundingLabel(p: Pick<Provider, 'authMode' | 'fundingSource'>): string {
  if (p.authMode === 'openai-oauth') return tx('Using ChatGPT plan', '正在使用 ChatGPT 套餐')
  if (p.authMode === 'subscription-key' || p.fundingSource === 'subscription') return tx('Subscription / extra usage', '订阅 / 额外用量')
  if (p.authMode === 'none' || p.fundingSource === 'local') return tx('Local model', '本地模型')
  return tx('API billing', 'API 按量计费')
}

export function usageUrl(p: Pick<Provider, 'presetId' | 'baseUrl' | 'authMode'>): string | undefined {
  if (p.authMode === 'openai-oauth') return 'https://chatgpt.com/settings/usage'
  if (p.authMode === 'subscription-key') return subscriptionRoute(p)?.usageUrl
  const urls: Record<string, string> = { openai: 'https://platform.openai.com/usage', openrouter: 'https://openrouter.ai/activity', moonshot: 'https://platform.moonshot.cn/console', deepseek: 'https://platform.deepseek.com/usage', minimax: 'https://platform.minimaxi.com/', zhipu: 'https://open.bigmodel.cn/', dashscope: 'https://bailian.console.aliyun.com/' }
  return urls[p.presetId ?? '']
}

export function usageApi(p: Pick<Provider, 'presetId' | 'baseUrl' | 'authMode' | 'extraHeaders'>): 'openrouter' | 'minimax' | 'deepseek' | undefined {
  if (Object.keys(p.extraHeaders ?? {}).length) return undefined
  const base = p.baseUrl.replace(/\/+$/, '')
  if (p.presetId === 'openrouter' && base === 'https://openrouter.ai/api/v1') return 'openrouter'
  if (p.presetId === 'minimax' && p.authMode === 'subscription-key' && base === 'https://api.minimax.io/v1') return 'minimax'
  if (p.presetId === 'deepseek' && ['https://api.deepseek.com', 'https://api.deepseek.com/v1'].includes(base)) return 'deepseek'
  return undefined
}
