import { AlertTriangle, ArchiveRestore, ArrowRight, CheckCircle2, DatabaseBackup, FolderOpen, History, MoreHorizontal, Power, RefreshCw, Shuffle, Trash2, UserRound } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { AccioAccount, BackupInfo, MigrationReport } from '../../../shared/types.ts'
import { PageHeader } from '../App.tsx'
import { Badge, Button, Card, CardHeader, Confirm, EmptyState, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, SelectBox, Skeleton } from '../components/ui.tsx'
import { api } from '../lib/api.ts'
import { fmtBytes, fmtDateTime, timeAgo } from '../lib/format.ts'
import { useStore } from '../lib/store.tsx'

const REASON: Record<BackupInfo['reason'], { label: string; tone: 'neutral' | 'accent' | 'warning' }> = {
  manual: { label: '手动', tone: 'accent' },
  'before-restore': { label: '恢复前自动', tone: 'neutral' },
  'before-migrate': { label: '迁移前自动', tone: 'neutral' },
}

function accountLabel(accounts: AccioAccount[], id: string): string {
  const a = accounts.find((x) => x.id === id)
  return a?.name ? `${a.name}（${id}）` : id
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
      toast.error('迁移失败', { description: (e as Error).message })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Modal
      open={!!backup}
      onOpenChange={(v) => !v && !running && !rolling && onClose()}
      title={report ? report.warnings.length ? '迁移未完整完成' : '迁移完成' : '迁移会话到其他账号'}
      description={report ? undefined : '把这份备份里的会话、智能体和任务复制到另一个你已登录过的账号。'}
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
                  toast.success('已回滚到迁移前的状态')
                  onDone()
                  onClose()
                } catch (e) {
                  toast.error('回滚失败', { description: (e as Error).message })
                } finally {
                  setRolling(false)
                }
              }}
            >
              <History />
              撤销这次迁移
            </Button>
            <Button variant="primary" onClick={onClose}>
              完成
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={running}>取消</Button>
            <Button variant="primary" onClick={run} loading={running} disabled={!target}>
              <Shuffle />
              开始迁移
            </Button>
          </>
        )
      }
    >
      {report ? (
        <div className="space-y-4">
          <div className={`flex items-center gap-3 rounded-xl px-4 py-3 text-[13px] ${report.warnings.length ? 'bg-warning-soft text-warning' : 'bg-success-soft text-success'}`}>
            <CheckCircle2 className="size-5 shrink-0" />
            {report.warnings.length ? '迁移已停止，目标可能包含部分新增数据。请查看原因，必要时撤销这次迁移。' : '迁移已完成，重新打开 Accio 查看目标账号中的会话。'}
          </div>
          <dl className="grid grid-cols-2 gap-3 text-[13px]">
            {(
              [
                ['新增文件', report.filesCopied],
                ['重写 ID 的文件', report.filesRewritten],
                ['重命名路径', report.pathsRenamed],
                ['合并数据库记录', report.sqliteRowsMerged],
                ['已存在而跳过', report.filesSkipped],
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
          <p className="text-[12px] text-subtle">目标账号迁移前的完整状态已自动备份，如有问题可以随时撤销。</p>
        </div>
      ) : backup ? (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-4 py-3">
              <div className="text-[11.5px] text-subtle">来源备份</div>
              <div className="truncate text-[13px] font-medium">{accountLabel(accounts, backup.accountId)}</div>
              <div className="text-[11.5px] text-muted">
                {fmtDateTime(backup.createdAt)} · {backup.conversations} 个会话
              </div>
            </div>
            <ArrowRight className="size-5 shrink-0 text-subtle" />
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[11.5px] text-subtle">目标账号</div>
              {targets.length ? (
                <SelectBox label="目标账号" value={target} onChange={setTarget} options={targets.map((a) => ({ value: a.id, label: a.name ?? a.id, description: `${a.id}${a.isCurrent ? ' · 当前账号' : ''}` }))} />
              ) : (
                <div className="text-[12.5px] text-warning">没有其他账号。请先在 Accio 中登录目标账号一次。</div>
              )}
            </div>
          </div>
          <ul className="space-y-2 rounded-xl border border-border px-4 py-3 text-[12.5px] leading-relaxed text-muted">
            <li>• 仅改写已识别的账号归属、ID 和路径字段；正文、工具内容、生成文件与技能保持原文。不支持的引用结构会在写入目标前停止。</li>
            <li>• 目标账号已有的会话不会被覆盖；冲突时保留目标账号的版本。</li>
            <li>• 开始前会自动完整备份目标账号，迁移后可以一键撤销。</li>
            <li>• 迁移前需要关闭 Accio。</li>
          </ul>
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
      if (version === loadVersion.current) setLoadError(`读取会话与备份失败：${e instanceof Error ? e.message : String(e)}`)
    } finally { if (version === loadVersion.current) setLoading(false) }
  }, [])
  useEffect(() => {
    void load()
    return () => { loadVersion.current++ }
  }, [load])

  const backupNow = async (id: string) => {
    setBusy(id)
    try {
      const b = await api.createBackup(id)
      toast.success('备份完成', { description: `${b.conversations} 个会话 · ${fmtBytes(b.sizeBytes)}` })
      await load()
    } catch (e) {
      toast.error('备份失败', { description: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader
        title="会话备份"
        description="备份 Accio 的会话、智能体与任务，或把它们迁移到你的另一个账号。"
        actions={
          <Button loading={loading} onClick={() => void load()}>
            <RefreshCw />
            刷新
          </Button>
        }
      />
      {loadError ? <Card className="mb-4 border-danger/30 p-4"><p role="alert" className="text-[13px] text-danger">{loadError}</p><p className="mt-1 text-[12px] text-muted">{accounts || backups ? '下方保留上次读取的列表，重新读取成功后才能操作。' : '尚未获得列表，请检查目录权限后重试。'}</p><Button className="mt-3" size="sm" loading={loading} onClick={() => void load()}>重新读取</Button></Card> : null}
      <fieldset disabled={loading || !!loadError || !!state?.busyOperation} className="min-w-0 space-y-6">
        {accioRunning ? (
          <Card className="flex items-center gap-4 border-warning/40 bg-warning-soft/60 px-5 py-3.5">
            <AlertTriangle className="size-5 shrink-0 text-warning" />
            <div className="min-w-0 flex-1 text-[13px]">
              <span className="font-medium">Accio 正在运行。</span>
              <span className="text-muted">备份可以正常进行；恢复和迁移需要先关闭 Accio，避免数据被覆盖。</span>
            </div>
            <Button
              size="sm"
              onClick={async () => {
                await api.accioStop()
                toast('Accio 已关闭')
              }}
            >
              <Power />
              关闭 Accio
            </Button>
          </Card>
        ) : null}

        <section>
          <h3 className="mb-3 text-[15px] font-semibold tracking-tight">账号</h3>
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
                        <span className="truncate text-[14px] font-semibold">{a.name ?? '未命名账号'}</span>
                        {a.isCurrent ? <Badge tone="success">最近登录</Badge> : null}
                      </div>
                      <div className="font-mono text-[11.5px] text-subtle">{a.id}</div>
                    </div>
                    <Button variant="ghost" size="icon-sm" aria-label="打开账号目录" onClick={() => void api.openPath(a.path)}>
                      <FolderOpen />
                    </Button>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-[12px]">
                    <div>
                      <div className="text-subtle">会话</div>
                      <div className="font-display text-[18px] font-semibold tabular">{a.conversations}</div>
                    </div>
                    <div>
                      <div className="text-subtle">智能体</div>
                      <div className="font-display text-[18px] font-semibold tabular">{a.agents}</div>
                    </div>
                    <div>
                      <div className="text-subtle">占用</div>
                      <div className="font-display text-[18px] font-semibold tabular">{fmtBytes(a.sizeBytes)}</div>
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-[12px] text-subtle">最近活动 {timeAgo(a.modifiedAt)}</span>
                    <Button variant="primary" size="sm" loading={busy === a.id} onClick={() => void backupNow(a.id)}>
                      <DatabaseBackup />
                      立即备份
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState icon={<UserRound />} title="没有找到账号数据" description="Accio 的数据目录（~/.accio/accounts）中还没有登录过的账号。" />
            </Card>
          )}
        </section>

        <Card>
          <CardHeader title="备份" description={backups ? `${backups.length} 份 · 共 ${fmtBytes(backups.reduce((s, b) => s + b.sizeBytes, 0))}` : undefined} />
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
                      </div>
                      <div className="truncate text-[12px] text-muted">
                        {accounts ? accountLabel(accounts, b.accountId) : b.accountId} · {b.conversations} 个会话 · {fmtBytes(b.sizeBytes)}
                        {b.note ? ` · ${b.note}` : ''}
                      </div>
                    </div>
                    <Button size="sm" disabled={accioRunning} onClick={() => setRestoring(b)} title={accioRunning ? '请先关闭 Accio' : undefined}>
                      恢复
                    </Button>
                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label="更多操作">
                          <MoreHorizontal />
                        </Button>
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem disabled={accioRunning} onSelect={() => setMigrating(b)}>
                          <Shuffle />
                          迁移到其他账号…
                        </MenuItem>
                        <MenuItem onSelect={() => void api.openPath(b.path)}>
                          <FolderOpen />
                          打开备份目录
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem danger onSelect={() => setDeleting(b)}>
                          <Trash2 />
                          删除
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<DatabaseBackup />} title="还没有备份" description="点击账号卡片上的「立即备份」。支持 SQLite 在线备份；重要恢复点建议关闭 Accio 后备份，以保持各文件一致。" />
            )}
          </div>
        </Card>
      </fieldset>

      <Confirm
        open={!!restoring}
        onOpenChange={(v) => !v && setRestoring(null)}
        title="恢复这份备份？"
        description={restoring ? `账号 ${restoring.accountId} 的数据会回到 ${fmtDateTime(restoring.createdAt)} 的状态。恢复前会自动备份当前数据，可以随时再恢复回来。` : ''}
        confirmText="恢复"
        onConfirm={async () => {
          if (!restoring) return
          try {
            await api.restoreBackup(restoring.id)
            toast.success('恢复完成', { description: '重新打开 Accio 即可看到恢复后的会话' })
            await load()
          } catch (e) {
            toast.error('恢复失败', { description: (e as Error).message })
          }
        }}
      />
      <Confirm
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="删除这份备份？"
        description="备份文件会被永久删除。"
        confirmText="删除"
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
