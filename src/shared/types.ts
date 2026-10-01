// Types shared by the main process (proxy, stores) and the renderer (UI).

export type ProviderKind = 'openai' | 'anthropic' | 'gemini'

export type ThinkingMode = 'off' | 'adaptive' | 'budget'
export type AuthMode = 'api-key' | 'subscription-key' | 'openai-oauth' | 'openrouter-oauth' | 'none'
export type FundingSource = 'api' | 'subscription' | 'local'

export interface AuthorizationView {
  id: string
  service: 'openai' | 'openrouter'
  label: string
  connected: boolean
  planEnabled: boolean
  expiresAt?: number
  firstSignIn?: boolean
  pauseReason?: string
}

export interface CapabilityCheck extends TestResult {
  scope: TestScope
  checkedAt: number
}

export interface ProviderPricing {
  /** USD per 1M input tokens (uncached). */
  input?: number
  /** USD per 1M output tokens. */
  output?: number
  /** USD per 1M cached input tokens. */
  cachedInput?: number
  /** USD per 1M tokens written to the prompt cache. */
  cacheWriteInput?: number
}

export interface ModelInfo {
  model: string
  contextWindow?: number
  windowKind?: 'context' | 'input'
  maxOutputTokens?: number
  tools?: boolean
  vision?: boolean
  thinking?: ThinkingMode
  source: 'official' | 'api' | 'user'
  sourceUrl?: string
  checkedAt: number
  pricing?: ProviderPricing
}

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  /** Absent keeps existing Chat Completions configurations. */
  openaiApi?: 'chat' | 'responses'
  allowInsecureHttp?: boolean
  /** Preset this provider was created from, used for the icon/colour. */
  presetId?: string
  authMode?: AuthMode
  credentialId?: string
  fundingSource?: FundingSource
  /** Explicit acknowledgement of the provider's personal-use subscription restrictions. */
  subscriptionAcknowledged?: boolean
  /** A manually selected fallback candidate; never replays an in-flight request. */
  fallbackEligible?: boolean
  baseUrl: string
  /** Encrypted at rest; the renderer only ever sees a masked value. */
  apiKey: string
  /** Target model used when no override matches the model Accio asked for. */
  model: string
  /** Accio model code → provider model. */
  modelOverrides: Record<string, string>
  /** Fixed max output tokens; overrides what Accio asks for when set. */
  maxOutputTokens?: number
  /** Forward Accio's reasoning effort (OpenAI `reasoning_effort`, Anthropic `output_config.effort`). */
  sendReasoningEffort?: boolean
  /** OpenAI-compatible: send prior reasoning back as `reasoning_content` (DeepSeek, Kimi…). */
  sendReasoningContent?: boolean
  /** Anthropic: thinking configuration. */
  thinking?: ThinkingMode
  thinkingBudget?: number
  /** Anthropic: add cache_control breakpoints. */
  promptCaching?: boolean
  /** Forward temperature / top_p from Accio (some newer models reject them). */
  sendSampling?: boolean
  extraHeaders?: Record<string, string>
  pricing?: ProviderPricing
  /** Pricing and model metadata are tied to one target model, never to overrides. */
  pricingModel?: string
  pricingUpdatedAt?: number
  modelInfo?: ModelInfo
  note?: string
  createdAt: number
}

/** Form input for creating/updating a provider. `apiKey` undefined keeps the stored key. */
export type ProviderInput = Omit<Provider, 'id' | 'createdAt' | 'apiKey'> & { id?: string; apiKey?: string }

/** The primary API key stays masked. Advanced headers remain editable in the renderer. */
export interface ProviderView extends Omit<Provider, 'apiKey'> {
  apiKeyMasked: string
  hasApiKey: boolean
  keyError?: string
  protection?: ConnectionProtection
  authorization?: AuthorizationView
  checks?: CapabilityCheck[]
  /** Main-process identity of the saved connection; never accepted from form input. */
  connectionFingerprint?: string
}

export interface ConnectionProtection {
  active: number
  limit: number
  retryAt?: number
}

export type NetworkProxyMode = 'system' | 'direct' | 'custom'

export interface AppSettings {
  /** Display language; configurations without this setting default to English. */
  language?: 'en' | 'zh-CN'
  proxyPort: number
  /** Upstream Accio gateway for pass-through traffic. */
  upstreamGateway: string
  accioExePath: string
  networkProxy: NetworkProxyMode
  networkProxyUrl: string
  launchAccioOnStart: boolean
  minimizeToTray: boolean
  openAtLogin: boolean
  /** Keep full request/response bodies for the last requests (in memory only). */
  debugCapture: boolean
  /** Stop a BYOK request after this many seconds without a valid upstream event. */
  upstreamIdleTimeoutSeconds?: number
  theme: 'system' | 'light' | 'dark'
  autoBackup?: boolean
  backupRetention?: number
}

export const OFFICIAL_PROVIDER_ID = 'official'

export interface AppConfig {
  version: 1
  activeProviderId: string
  providers: Provider[]
  settings: AppSettings
}

export interface UsageNumbers {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheWriteTokens?: number
  reasoningTokens: number
  usageReported?: boolean
  cacheReadReported?: boolean
  cacheWriteReported?: boolean
}

export type RequestStatus = 'ok' | 'error' | 'aborted'

export interface RequestLog extends UsageNumbers {
  id: string
  ts: number
  mode: 'byok' | 'official'
  providerId: string
  providerName: string
  /** Connection captured when this request started. Missing on older logs. */
  connectionFingerprint?: string
  accioModel: string
  targetModel: string
  status: RequestStatus
  httpStatus?: number
  notSent?: boolean
  durationMs: number
  ttftMs?: number
  toolCalls: number
  finishReason?: string
  error?: string
  conversationId?: string
  agentId?: string
  costUsd?: number
  costComplete?: boolean
  pricing?: ProviderPricing
  pricingUpdatedAt?: number
  fundingSource?: FundingSource
  contextWindow?: number
  estimatedInputTokens?: number
  contextWindowKind?: 'context' | 'input'
  contextWindowSource?: ModelInfo['source']
  contextWindowCheckedAt?: number
  contextEstimateIncomplete?: boolean
  errorCode?: string
  requestId?: string
}

export interface RequestCapture {
  id: string
  request: unknown
  upstreamRequest?: unknown
  events: string[]
}

export interface UsageBucket extends UsageNumbers {
  key: string
  requests: number
  errors: number
  aborted?: number
  estimatedRequests?: number
  fullyEstimatedRequests?: number
  byokRequests?: number
  apiRequests?: number
  subscriptionRequests?: number
  localRequests?: number
  cacheReportedRequests?: number
  cacheReportedInputTokens?: number
  cacheReportedTokens?: number
  costUsd: number
  durationMs: number
}

export interface UsageStats {
  from: number
  to: number
  totals: UsageBucket
  byDay: UsageBucket[]
  byProvider: (UsageBucket & { name: string })[]
  byModel: UsageBucket[]
}

export interface AccioStatus {
  version?: string
  installed: boolean
  exePath: string
  running: boolean
  pids: number[]
  /** Traffic was observed during the current Accio launch / proxy cycle. */
  takenOver: boolean
  lastSeenAt?: number
  launchedByUs: boolean
  startedAt?: number
  operation?: 'starting' | 'stopping' | 'direct'
  error?: string
}

export interface UpdateInfo {
  version: string
  newer: boolean
  prerelease: boolean
  checkedAt: number
  notes: string
  pageUrl: string
  assets: { name: string; size: number; sha256?: string }[]
}

export interface DiagnosticPreview { id: string; content: string; includesContent: boolean }
export interface ProviderUsageSnapshot { checkedAt: number; sourceUrl: string; fields: { label: string; value: string }[]; note: string }

export interface ProxyStatus {
  running: boolean
  port: number
  url: string
  error?: string
  startedAt?: number
}

export interface AccioAccount {
  id: string
  name?: string
  path: string
  sizeBytes: number
  conversations: number
  agents: number
  modifiedAt: number
  isCurrent: boolean
}

export interface BackupInfo {
  id: string
  accountId: string
  createdAt: number
  sizeBytes: number
  fileCount: number
  conversations: number
  reason: 'manual' | 'automatic' | 'before-restore' | 'before-migrate'
  consistency?: 'closed' | 'live'
  integrity?: 'sha256' | 'legacy'
  note?: string
  path: string
}

export interface MigrationReport {
  sourceAccountId: string
  targetAccountId: string
  safetyBackupId: string
  filesCopied: number
  filesSkipped: number
  filesRewritten: number
  pathsRenamed: number
  sqliteRowsMerged: number
  warnings: string[]
}

export interface BackupPreview {
  id: string
  sourceAccountId: string
  targetAccountId: string
  files: number
  sizeBytes: number
  integrity: 'sha256' | 'legacy'
  consistency: 'closed' | 'live' | 'unknown'
  databasesChecked: number
  filesRewritten: number
  pathsRenamed: number
  existingFiles: number
  warnings: string[]
}

export interface AutoBackupStatus {
  state: 'disabled' | 'waiting' | 'running' | 'ok' | 'error'
  checkedAt?: number
  completedAt?: number
  lastBackupIds?: string[]
  message?: string
}

export interface AccioModelInfo {
  code: string
  name: string
  provider: string
  visible: boolean
}

export type TestScope = 'text' | 'tools' | 'image' | 'multiturn'

export interface TestResult {
  ok: boolean
  latencyMs: number
  model: string
  message: string
  scope?: TestScope
  checkedAt?: number
  notSent?: boolean
  protection?: ConnectionProtection
}

export type AppEvent =
  | { type: 'storage-error'; message: string }
  | { type: 'log'; entry: RequestLog }
  | { type: 'status' }
  | { type: 'config' }
  | { type: 'navigate'; page: 'home' | 'providers' | 'usage' | 'sessions' | 'settings'; intent?: string }
