import { useEffect, useState } from 'react'
import { DatabaseBackup } from 'lucide-react'
import { tx } from '../../../shared/i18n.ts'
import type { BackupInfo } from '../../../shared/types.ts'
import { api } from '../lib/api.ts'
import { fmtDateTime, timeAgo } from '../lib/format.ts'
import { useStore, useTicker } from '../lib/store.tsx'
import { Button } from './ui.tsx'

/** Dates come from completed on-disk snapshots, not the last scheduler check. */
export function BackupFreshness({ backups, loading, error }: { backups?: BackupInfo[] | null; loading?: boolean; error?: string }) {
  const { state } = useStore()
  useTicker()
  const pending = loading || (!backups && !error)
  const latest = backups?.filter((b) => b.consistency === 'closed' && Number.isFinite(b.createdAt) && b.createdAt > 0).reduce<BackupInfo | undefined>((last, b) => !last || b.createdAt > last.createdAt ? b : last, undefined)
  const old = latest && Date.now() - latest.createdAt >= 7 * 86_400_000
  return <div className="min-w-0 space-y-1 text-[12px] leading-relaxed" data-backup-freshness>
    <p className={error ? 'text-danger' : old || (!pending && !latest) ? 'text-warning' : 'text-muted'}>
      <span className="font-medium">{tx('Latest backup with Accio closed', '最近一次关闭 Accio 后的备份')}</span>
      {' · '}{pending ? tx('Reading…', '读取中…') : error ? tx('Status unavailable', '状态无法读取') : latest ? timeAgo(latest.createdAt) : tx('None recorded', '尚无记录')}
    </p>
    {!pending && !error && latest ? <p className="text-subtle">{fmtDateTime(latest.createdAt)} · {tx('Account', '账号')} {latest.accountId} · {tx('Latest across accounts; others may have older or no backups.', '这是各账号中最新的一份；其他账号可能更早或尚无备份。')}</p> : null}
    {error ? <p className="break-words text-danger">{error}</p> : !pending && (!latest || old) ? <p className="text-muted">{latest ? tx('If you have worked since the last backup, close Accio and create a new snapshot in Session backups.', '如果上次备份后有新工作，请关闭 Accio，并在会话备份中创建新快照。') : tx('Close Accio, then create a snapshot in Session backups.', '请关闭 Accio，再到会话备份中创建快照。')}</p> : null}
    {state?.settings.autoBackup && state.accio.running ? <p className="text-muted">{tx('Automatic backups are waiting for Accio to close. An enabled schedule does not mean a backup has completed.', '自动备份正在等待 Accio 关闭；已开启计划不代表已经完成备份。')}</p> : null}
  </div>
}

/** Overview reads the same persisted list as Session backups, including after restart. */
export function OverviewBackupStatus() {
  const { state, go } = useStore()
  const [backups, setBackups] = useState<BackupInfo[]>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!state?.dataDir || state.busyOperation) return
    let current = true
    setLoading(true)
    void api.listBackups().then((items) => { if (current) { setBackups(items); setError(undefined) } }).catch((e) => { if (current) setError(e instanceof Error ? e.message : String(e)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [state?.dataDir, state?.busyOperation, state?.autoBackup?.completedAt])
  return <div className="flex flex-wrap items-start gap-3 border-t border-border px-6 py-3">
    <DatabaseBackup className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden />
    <div className="min-w-48 flex-1"><BackupFreshness backups={backups} loading={loading} error={error} /></div>
    <Button size="sm" variant="ghost" onClick={() => go('sessions')}>{tx('Review backups', '查看备份')}</Button>
  </div>
}
