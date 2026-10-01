import { tr, tx } from '../../../shared/i18n.ts'
import { AlertTriangle, ArchiveRestore, ArrowRight, CheckCircle2, DatabaseBackup, FolderOpen, History, MoreHorizontal, Power, RefreshCw, Shuffle, Trash2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AccioAccount, BackupInfo, BackupPreview, MigrationReport } from '../../../shared/types.ts'
import { PageHeader } from '../App.tsx'
import { Badge, Button, Card, CardHeader, Confirm, EmptyState, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, SelectBox, Skeleton, Switch } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { fmtBytes, fmtDateTime, timeAgo } from '../lib/format.ts'
import { useStore } from '../lib/store.tsx'
import { BackupFreshness } from '../components/BackupFreshness.tsx'

const REASON: Record<BackupInfo['reason'], { label: string; tone: 'neutral' | 'accent' | 'warning' }> = {
  automatic: { get label() { return tx('Automatic', '自动备份') }, tone: 'accent' },
  manual: { get label() { return tr("手动") }, tone: 'accent' },
  'before-restore': { get label() { return tr("恢复前自动") }, tone: 'neutral' },
  'before-migrate': { get label() { return tr("迁移前自动") }, tone: 'neutral' },
}

function accountLabel(accounts: AccioAccount[], id: string): string {
  const a = accounts.find((x) => x.id === id)
  return a?.name ? `${a.name}（${id}）` : id
}

function useBackupPreview(id?: string, target?: string) {
  const [preview, setPreview] = useState<BackupPreview>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setPreview(undefined); setError(undefined)
    if (id) void api.previewBackup(id, target).then((p) => { if (current) setPreview(p) }).catch((e) => { if (current) setError(e.message) })
    return () => { current = false }
  }, [id, target, attempt])
  return { preview, error, retry: () => setAttempt((n) => n + 1) }
}

function PreviewDetails({ preview, error, retry }: ReturnType<typeof useBackupPreview>) {
  if (error) return <div role="alert" className="space-y-2 rounded-lg bg-danger-soft p-3 text-[12.5px] text-danger"><p>{error}</p><Button size="sm" onClick={retry}>{tr('重新读取')}</Button></div>
  if (!preview) return <p role="status" className="text-[13px] text-muted">{tx('Checking file contents and databases…', '正在检查文件内容与数据库…')}</p>
  return <div className="space-y-2 rounded-xl border border-border p-4 text-[12.5px] text-muted">
    <p className="font-medium text-fg">{tx('Restore preview', '恢复预览')} · {preview.files} {tx('files', '个文件')} · {fmtBytes(preview.sizeBytes)}</p>
    <p>{preview.integrity === 'sha256' ? tx('SHA-256 verified', 'SHA-256 校验通过') : tx('Legacy integrity checks', '旧版完整性检查')} · SQLite {preview.databasesChecked}</p>
    <p>{preview.consistency === 'closed' ? tx('Captured with Accio closed', '备份时 Accio 已关闭') : tx('Cross-file consistency is unconfirmed', '跨文件一致性未确认')}</p>
    {preview.sourceAccountId !== preview.targetAccountId ? <p>{tx('Migration preview', '迁移预演')} · {preview.filesRewritten} {tx('files rewritten', '个文件改写')} · {preview.pathsRenamed} {tx('paths renamed', '个路径更名')} · {preview.existingFiles} {tx('existing files', '个已有文件')}</p> : null}
    {preview.warnings.map((w) => <p key={w} className="text-warning">{w}</p>)}
  </div>
}

function RestoreDialog({ backup, onClose, onDone }: { backup: BackupInfo | null; onClose(): void; onDone(): void }) {
  const review = useBackupPreview(backup?.id)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => setError(undefined), [backup])
  return <Modal open={!!backup} onOpenChange={(v) => { if (!v && !running) onClose() }} title={tr('恢复这份备份？')} footer={<><Button onClick={onClose} disabled={running}>{tr('取消')}</Button><Button variant="primary" disabled={!review.preview} loading={running} onClick={async () => {
    if (!backup) return
    setRunning(true); setError(undefined)
    try { await api.restoreBackup(backup.id); toast.success(tr('恢复完成')); onDone(); onClose() } catch (e) { setError((e as Error).message) } finally { setRunning(false) }
  }}>{tr('恢复')}</Button></>}>
    <div className="space-y-4"><p className="text-[13px] text-muted">{backup ? tr('账号 {0} 的数据会回到 {1} 的状态。恢复前会自动备份当前数据，可以随时再恢复回来。', backup.accountId, fmtDateTime(backup.createdAt)) : ''}</p><PreviewDetails {...review} />{error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}</div>
  </Modal>
}

function MigrateDialog({
  backup,
  accounts,
  onClose,
  onDone,
}: {
  backup: BackupInfo | null
  accounts: AccioAccount[]
  onClose: () => void
  onDone: () => void
}) {
  const targets = accounts.filter((a) => a.id !== backup?.accountId)
  const [target, setTarget] = useState<string>()
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<MigrationReport | null>(null)
  const [rolling, setRolling] = useState(false)
  const review = useBackupPreview(target && backup ? backup.id : undefined, target)

  useEffect(() => {
    setReport(null)
    setTarget(targets.find((a) => a.isCurrent)?.id ?? targets[0]?.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backup])

  const run = async () => {
    if (!backup || !target) return
    setRunning(true)
    try {
      setReport(await api.migrateBackup(backup.id, target))
      onDone()
    } catch (e) {
      toast.error(tr("迁移失败"), { description: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal
      open={!!backup}
      onOpenChange={(v) => !v && !running && !rolling && onClose()}
      title={report ? report.warnings.length ? tr("迁移未完整完成") : tr("迁移完成") : tr("迁移会话到其他账号")}
      description={report ? undefined : tr("把这份备份里的会话、智能体和任务复制到另一个你已登录过的账号。")}
      footer={
        report ? (
          <>
            <Button
              variant="danger-ghost"
              className="mr-auto"
              loading={rolling}
              onClick={async () => {
                setRolling(true)
                try {
                  await api.restoreBackup(report.safetyBackupId)
                  toast.success(tr("已回滚到迁移前的状态"))
                  onDone()
                  onClose()
                } catch (e) {
                  toast.error(tr("回滚失败"), { description: (e as Error).message })
                } finally {
                  setRolling(false)
                }
              }}
            >
              <History />
              {tr("撤销这次迁移")}</Button>
            <Button variant="primary" onClick={onClose}>
              {tr("完成")}</Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={running}>{tr("取消")}</Button>
            <Button variant="primary" onClick={run} loading={running} disabled={!target || !review.preview}>
              <Shuffle />
              {tr("开始迁移")}</Button>
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-4">
          <div className={`flex items-center gap-3 rounded-xl px-4 py-3 text-[13px] ${report.warnings.length ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success'}`}>
            <CheckCircle2 className="size-5 shrink-0" />
            {report.warnings.length ? tr("迁移已停止，目标可能包含部分新增数据。请查看原因，必要时撤销这次迁移。") : tr("迁移已完成，重新打开 Accio 查看目标账号中的会话。")}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            {(
              [
                [tr("新增文件"), report.filesCopied],
                [tr("重写 ID 的文件"), report.filesRewritten],
                [tr("重命名路径"), report.pathsRenamed],
                [tr("合并数据库记录"), report.sqliteRowsMerged],
                [tr("已存在而跳过"), report.filesSkipped],
              ] as [string, number][]
            ).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-border px-4 py-3">
                <dt className="text-[12px] text-muted">{k}</dt>
                <dd className="mt-0.5 font-display text-[20px] font-semibold tabular">{v}</dd>
              </div>
            ))}
          </dl>
          {report.warnings.length ? (
            <div className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-[12.5px] text-warning">
              {report.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          ) : null}
          <p className="text-[12px] text-subtle">{tr("目标账号迁移前的完整状态已自动备份，如有问题可以随时撤销。")}</p>
        </div>
      ) : backup ? (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-4 py-3">
              <div className="text-[11.5px] text-subtle">{tr("来源备份")}</div>
              <div className="truncate text-[13px] font-medium">{accountLabel(accounts, backup.accountId)}</div>
              <div className="text-[11.5px] text-muted">
                {fmtDateTime(backup.createdAt)} · {backup.conversations} {tr(" 个会话")}</div>
            </div>
            <ArrowRight className="size-5 shrink-0 text-subtle" />
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[11.5px] text-subtle">{tr("目标账号")}</div>
              {targets.length ? (
                <SelectBox label={tr("目标账号")} value={target} onChange={setTarget} options={targets.map((a) => ({ value: a.id, label: a.name ?? a.id, description: `${a.id}${a.isCurrent ? tr(" · 当前账号") : ''}` }))} />
              ) : (
                <div className="text-[12.5px] text-warning">{tr("没有其他账号。请先在 Accio 中登录目标账号一次。")}</div>
              )}
            </div>
          </div>
          <ul className="space-y-2 rounded-xl border border-border px-4 py-3 text-[12.5px] leading-relaxed text-muted">
            <li>{tr("• 仅改写已识别的账号归属、ID 和路径字段；正文、工具内容、生成文件与技能保持原文。不支持的引用结构会在写入目标前停止。")}</li>
            <li>{tr("• 目标账号已有的会话不会被覆盖；冲突时保留目标账号的版本。")}</li>
            <li>{tr("• 开始前会自动完整备份目标账号，迁移后可以一键撤销。")}</li>
            <li>{tr("• 迁移前需要关闭 Accio。")}</li>
          </ul>
          <PreviewDetails {...review} />
        </div>
      ) : null}
    </Modal>
  )
}

export function SessionsPage() {
  const { state } = useStore()
  const [accounts, setAccounts] = useState<AccioAccount[] | null>(null)
  const [backups, setBackups] = useState<BackupInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<BackupInfo | null>(null)
  const [deleting, setDeleting] = useState<BackupInfo | null>(null)
  const [migrating, setMigrating] = useState<BackupInfo | null>(null)
  const [loadError, setLoadError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const loadVersion = useRef(0)
  const accioRunning = state?.accio.running ?? false

  const load = useCallback(async () => {
    const version = ++loadVersion.current
    setLoading(true)
    try {
      const [a, b] = await Promise.all([api.listAccounts(), api.listBackups()])
      if (version !== loadVersion.current) return
      setAccounts(a)
      setBackups(b)
      setLoadError(undefined)
    } catch (e) {
      if (version === loadVersion.current) setLoadError(tr("读取会话与备份失败：{0}", e instanceof Error ? e.message : String(e)))
    } finally { if (version === loadVersion.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    return () => { loadVersion.current++ }
  }, [load, state?.autoBackup?.completedAt])

  const backupNow = async (id: string) => {
    setBusy(id)
    try {
      const b = await api.createBackup(id)
      toast.success(tr("备份完成"), { description: tr("{0} 个会话 · {1}", b.conversations, fmtBytes(b.sizeBytes)) })
      await load()
    } catch (e) {
      toast.error(tr("备份失败"), { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader
        title={tr("会话备份")}
        description={tr("备份 Accio 的会话、智能体与任务，或把它们迁移到你的另一个账号。")}
        actions={
          <Button loading={loading} onClick={() => void load()}>
            <RefreshCw />
            {tr("刷新")}</Button>
        }
      />
      {loadError ? <Card className="mb-4 border-danger/30 p-4"><p role="alert" className="text-[13px] text-danger">{loadError}</p><p className="mt-1 text-[12px] text-muted">{accounts || backups ? tr("下方保留上次读取的列表，重新读取成功后才能操作。") : tr("尚未获得列表，请检查目录权限后重试。")}</p><Button className="mt-3" size="sm" loading={loading} onClick={() => void load()}>{tr("重新读取")}</Button></Card> : null}
      <fieldset disabled={loading || !!loadError || !!state?.busyOperation} className="min-w-0 space-y-6">
        <Card className="space-y-3 p-5">
          <BackupFreshness backups={backups} loading={loading} error={loadError} />
          <div className="flex items-start justify-between gap-4"><div><h3 className="text-[14px] font-semibold">{tx('Automatic backups', '自动备份')}</h3><p className="mt-1 text-[12px] text-muted">{tx('Once a day while Accio is closed. Unchanged accounts are skipped. Manual and recovery backups are always retained.', '每天在 Accio 关闭时备份，跳过未变更账号。手动备份及恢复保护备份始终保留。')}</p></div><Switch label={tx('Automatic backups', '自动备份')} checked={state?.settings.autoBackup ?? false} onCheckedChange={(v) => void api.updateSettings({ autoBackup: v }).catch((e) => toast.error(e.message))} /></div>
          {state?.settings.autoBackup ? <><div className="flex flex-wrap items-center gap-3"><span className="text-[12px] text-muted">{tx('Keep per account', '每个账号保留')}</span><SelectBox label={tx('Automatic backup retention', '自动备份保留数量')} value={String(state.settings.backupRetention ?? 7)} onChange={(v) => void api.updateSettings({ backupRetention: Number(v) }).catch((e) => toast.error(e.message))} options={[1, 3, 7, 14, 30].map((n) => ({ value: String(n), label: String(n) }))} /><Button size="sm" disabled={accioRunning} onClick={async () => { const result = await api.runAutoBackup(); if (result.state === 'error') toast.error(result.message); await load() }}>{tx('Run now', '立即执行')}</Button></div><p role="status" className={`text-[12px] ${state.autoBackup?.state === 'error' ? 'text-danger' : 'text-muted'}`}>{state.autoBackup?.message || tx('Waiting for the next safe backup opportunity.', '等待下一次可安全备份的时机。')}{state.autoBackup?.checkedAt ? ` · ${fmtDateTime(state.autoBackup.checkedAt)}` : ''}</p></> : null}
        </Card>
        {accioRunning ? (
          <Card className="flex items-center gap-4 border-warning/40 bg-warning-soft/60 px-5 py-3.5">
            <AlertTriangle className="size-5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 text-[13px]">
              <span className="font-medium">{tr("Accio 正在运行。")}</span>
              <span className="text-muted">{tx('Manual backups remain available, but cross-file consistency is unconfirmed. Close Accio for a reliable restore point, restoration or migration.', '可手动备份，但跨文件一致性未确认；可靠恢复点、恢复和迁移都应先关闭 Accio。')}</span>
            </div>
            <Button
              size="sm"
              onClick={async () => {
                await api.accioStop()
                toast(tr("Accio 已关闭"))
              }}
            >
              <Power />
              {tr("关闭 Accio")}</Button>
          </Card>
        ) : null}

        <section>
          <h3 className="mb-3 text-[15px] font-semibold tracking-tight">{tr("账号")}</h3>
          {accounts === null && loadError ? null : accounts === null ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Skeleton className="h-36 rounded-2xl" />
              <Skeleton className="h-36 rounded-2xl" />
            </div>
          ) : accounts.length ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {accounts.map((a) => (
                <Card key={a.id} className="p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                      <UserRound className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-semibold">{a.name ?? tr("未命名账号")}</span>
                        {a.isCurrent ? <Badge tone="success">{tr("最近登录")}</Badge> : null}
                      </div>
                      <div className="font-mono text-[11.5px] text-subtle">{a.id}</div>
                    </div>
                    <Button variant="ghost" size="icon-sm" aria-label={tr("打开账号目录")} onClick={() => void api.openPath(a.path)}>
                      <FolderOpen />
                    </Button>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
                    <div>
                      <div className="text-subtle">{tr("会话")}</div>
                      <div className="font-display text-[18px] font-semibold tabular">{a.conversations}</div>
                    </div>
                    <div>
                      <div className="text-subtle">{tr("智能体")}</div>
                      <div className="font-display text-[18px] font-semibold tabular">{a.agents}</div>
                    </div>
                    <div>
                      <div className="text-subtle">{tr("占用")}</div>
                      <div className="font-display text-[18px] font-semibold tabular">{fmtBytes(a.sizeBytes)}</div>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-[12px] text-subtle">{tr("最近活动 ")}{timeAgo(a.modifiedAt)}</span>
                    <Button variant="primary" size="sm" loading={busy === a.id} onClick={() => void backupNow(a.id)}>
                      <DatabaseBackup />
                      {tr("立即备份")}</Button>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState icon={<UserRound />} title={tr("没有找到账号数据")} description={tr("Accio 的数据目录（~/.accio/accounts）中还没有登录过的账号。")} />
            </Card>
          )}
        </section>

        <Card>
          <CardHeader title={tr("备份")} description={backups ? tr("{0} 份 · 共 {1}", backups.length, fmtBytes(backups.reduce((s, b) => s + b.sizeBytes, 0))) : undefined} />
          <div className="mt-3 px-2 pb-2">
            {backups === null && loadError ? null : backups === null ? (
              <Skeleton className="mx-3 mb-3 h-24" />
            ) : backups.length ? (
              <ul className="divide-y divide-border">
                {backups.map((b) => (
                  <li key={b.id} className="flex items-center gap-4 rounded-lg px-3 py-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fg/[0.05] text-muted">
                      <ArchiveRestore className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium tabular">{fmtDateTime(b.createdAt)}</span>
                        <Badge tone={REASON[b.reason].tone}>{REASON[b.reason].label}</Badge>
                        <span className="text-[11px] text-subtle">{b.integrity === 'sha256' ? 'SHA-256' : tx('Legacy', '旧版')} · {b.consistency === 'closed' ? tx('Accio closed', 'Accio 已关闭') : tx('Consistency unconfirmed', '一致性未确认')}</span>
                      </div>
                      <div className="truncate text-[12px] text-muted">
                        {accounts ? accountLabel(accounts, b.accountId) : b.accountId} · {b.conversations} {tr(" 个会话 · ")}{fmtBytes(b.sizeBytes)}
                        {b.note ? ` · ${b.note}` : ''}
                      </div>
                    </div>
                    <Button size="sm" disabled={accioRunning} onClick={() => setRestoring(b)} title={accioRunning ? tr("请先关闭 Accio") : undefined}>
                      {tr("恢复")}</Button>
                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={tr("更多操作")}>
                          <MoreHorizontal />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem disabled={accioRunning} onSelect={() => setMigrating(b)}>
                          <Shuffle />
                          {tr("迁移到其他账号…")}</MenuItem>
                        <MenuItem onSelect={() => void api.openPath(b.path)}>
                          <FolderOpen />
                          {tr("打开备份目录")}</MenuItem>
                        <MenuSeparator />
                        <MenuItem danger onSelect={() => setDeleting(b)}>
                          <Trash2 />
                          {tr("删除")}</MenuItem>
                      </MenuContent>
                    </Menu>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<DatabaseBackup />} title={tr("还没有备份")} description={tr("点击账号卡片上的「立即备份」。支持 SQLite 在线备份；重要恢复点建议关闭 Accio 后备份，以保持各文件一致。")} />
            )}
          </div>
        </Card>
      </fieldset>

      <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} onDone={() => void load()} />
      <Confirm
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={tr("删除这份备份？")}
        description={tr("备份文件会被永久删除。")}
        confirmText={tr("删除")}
        danger
        onConfirm={async () => {
          if (deleting) await api.deleteBackup(deleting.id)
          await load()
        }}
      />
      <MigrateDialog backup={migrating} accounts={accounts ?? []} onClose={() => setMigrating(null)} onDone={() => void load()} />
    </>
  )
}
