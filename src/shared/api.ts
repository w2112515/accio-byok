import type {
  AccioAccount,
  AccioModelInfo,
  AccioStatus,
  AppEvent,
  AppSettings,
  BackupInfo,
  MigrationReport,
  ModelInfo,
  ProviderInput,
  ProviderView,
  ProxyStatus,
  RequestCapture,
  RequestLog,
  TestResult,
  TestScope,
  UsageStats,
  AuthorizationView,
  BackupPreview,
  AutoBackupStatus,
  UpdateInfo,
  DiagnosticPreview,
  ProviderUsageSnapshot,
} from './types.ts'

export interface AppState {
  version: string
  providers: ProviderView[]
  activeProviderId: string
  settings: AppSettings
  proxy: ProxyStatus
  accio: AccioStatus
  encryptionAvailable: boolean
  dataDir: string
  configError?: string
  operationError?: string
  busyOperation?: string
  authorizations?: AuthorizationView[]
  authorizationError?: string
  autoBackup?: AutoBackupStatus
}

/** Methods invokable from the renderer. All return promises over IPC. */
export interface AccioSwitchApi {
  checkUpdate(): Promise<UpdateInfo>
  downloadUpdate(name: string): Promise<{ path: string; configBackup: string }>
  installUpdate(): Promise<void>
  restoreConfigBackup(): Promise<void>
  diagnosticPreview(includeContent?: boolean): Promise<DiagnosticPreview>
  exportDiagnostic(id: string): Promise<string | undefined>
  signIn(service: 'openai' | 'openrouter', existingId?: string): Promise<AuthorizationView>
  cancelSignIn(): Promise<void>
  signOut(id: string): Promise<{ remoteRevoked: boolean }>
  resumeAuthorization(id: string): Promise<void>
  getState(): Promise<AppState>
  saveProvider(input: ProviderInput, activate?: boolean): Promise<ProviderView>
  recoverConfig(action: 'retry' | 'reset'): Promise<void>
  deleteProvider(id: string): Promise<void>
  duplicateProvider(id: string): Promise<ProviderView | undefined>
  activateProvider(id: string): Promise<void>
  reorderProviders(ids: string[]): Promise<void>
  testProvider(input: ProviderInput, scope?: TestScope): Promise<TestResult>
  listProviderModels(input: ProviderInput, refresh?: boolean): Promise<string[]>
  providerModelInfo(input: ProviderInput): Promise<ModelInfo | undefined>
  providerUsage(id: string): Promise<ProviderUsageSnapshot>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  restartProxy(): Promise<ProxyStatus>

  accioTakeover(): Promise<AccioStatus>
  accioStop(): Promise<AccioStatus>
  accioLaunchDirect(): Promise<AccioStatus>
  accioModels(): Promise<AccioModelInfo[]>
  browseAccioExe(): Promise<string | undefined>
  createDesktopShortcut(): Promise<string>

  recentLogs(limit?: number): Promise<RequestLog[]>
  usageStats(days: number): Promise<UsageStats>
  logCapture(id: string): Promise<RequestCapture | undefined>
  clearLogs(): Promise<void>

  listAccounts(): Promise<AccioAccount[]>
  listBackups(): Promise<BackupInfo[]>
  previewBackup(id: string, targetAccountId?: string): Promise<BackupPreview>
  runAutoBackup(): Promise<AutoBackupStatus>
  createBackup(accountId: string, note?: string): Promise<BackupInfo>
  restoreBackup(id: string): Promise<{ safetyBackupId: string }>
  migrateBackup(id: string, targetAccountId: string): Promise<MigrationReport>
  deleteBackup(id: string): Promise<void>

  openPath(target: string): Promise<void>
  openExternal(url: string): Promise<void>
}

export type ApiMethod = keyof AccioSwitchApi

export interface PreloadBridge {
  invoke<M extends ApiMethod>(method: M, ...args: Parameters<AccioSwitchApi[M]>): ReturnType<AccioSwitchApi[M]>
  onEvent(cb: (e: AppEvent) => void): () => void
}
