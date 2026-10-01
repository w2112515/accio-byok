import { tr } from '../shared/i18n.ts'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { AccioAccount, BackupInfo, MigrationReport } from '../shared/types.ts'

// node:sqlite ships with Electron's Node 24; loaded lazily so the module can be imported anywhere.
type Sqlite = typeof import('node:sqlite')
let sqlite: Sqlite | undefined
async function loadSqlite(): Promise<Sqlite> {
  sqlite ??= await import('node:sqlite')
  return sqlite
}

/** Everything that makes up an account's conversation history. */
const MIGRATE_ITEMS = ['conversations', 'agents', 'subagent-sessions', 'tasks', 'artifacts', 'skills', 'msg-archive', 'archive']
const STRUCTURED_EXT = new Set(['.json', '.jsonl'])
const SQLITE_EXT = new Set(['.db'])
const SQLITE_SIDECAR = /\.db-(wal|shm|journal)$/

export interface SessionPaths {
  accioDir: string
  backupDir: string
  rememberedAccountsFile: string
  beforeWrite?: () => Promise<void>
}

interface Manifest {
  accountId: string
  createdAt: number
  sizeBytes: number
  fileCount: number
  conversations: number
  reason: BackupInfo['reason']
  note?: string
}

async function exists(p: string): Promise<boolean> {
  return fsp.access(p).then(
    () => true,
    () => false,
  )
}

async function directoryNames(dir: string): Promise<string[]> {
  try { return await fsp.readdir(dir) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

async function walk(dir: string, visit: (file: string, stat: fs.Stats) => void | Promise<void>, skipLinks = false): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isSymbolicLink()) {
      if (skipLinks) continue
      throw new Error(tr("备份目录不支持符号链接：{0}", full))
    }
    if (e.isDirectory()) await walk(full, visit, skipLinks)
    else if (e.isFile()) await visit(full, await fsp.stat(full))
  }
}

async function dirStats(dir: string, skipLinks = false): Promise<{ size: number; files: number; mtime: number }> {
  let size = 0
  let files = 0
  let mtime = 0
  await walk(dir, (_f, st) => {
    size += st.size
    files++
    mtime = Math.max(mtime, st.mtimeMs)
  }, skipLinks)
  return { size, files, mtime }
}

async function countConversations(accountDir: string): Promise<number> {
  let n = 0
  for (const sub of ['dm', 'team']) {
    const names = await fsp.readdir(path.join(accountDir, 'conversations', sub)).catch(() => [] as string[])
    n += names.filter((f) => /^CID-.*\.json$/.test(f) && !f.includes('.message_') && !f.includes('.seq.')).length
  }
  return n
}

async function countAgents(accountDir: string): Promise<number> {
  const names = await fsp.readdir(path.join(accountDir, 'agents')).catch(() => [] as string[])
  return names.filter((n) => /^[A-Z]ID-/.test(n)).length
}

/** Copy a directory; SQLite databases go through the online backup API so they are consistent. */
async function copyTree(src: string, dst: string, only?: string[]): Promise<{ files: number; size: number }> {
  const { backup, DatabaseSync } = await loadSqlite()
  let files = 0
  let size = 0
  const roots = only ? only.map((n) => path.join(src, n)) : [src]
  for (const root of roots) {
    if (!(await exists(root))) continue
    const st = await fsp.stat(root)
    if (st.isFile()) {
      const target = path.join(dst, path.relative(src, root))
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await fsp.copyFile(root, target)
      files++
      size += st.size
      continue
    }
    await walk(root, async (file, fst) => {
      if (SQLITE_SIDECAR.test(file)) return
      const target = path.join(dst, path.relative(src, file))
      await fsp.mkdir(path.dirname(target), { recursive: true })
      if (SQLITE_EXT.has(path.extname(file))) {
        const db = new DatabaseSync(file, { readOnly: true })
        try {
          await backup(db, target)
        } finally {
          db.close()
        }
      } else {
        await fsp.copyFile(file, target)
      }
      files++
      size += fst.size
    })
  }
  return { files, size }
}

export class SessionManager {
  private paths: SessionPaths

  constructor(paths: SessionPaths) {
    this.paths = paths
  }

  private accountsDir(): string {
    return path.join(this.paths.accioDir, 'accounts')
  }

  private accountDir(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id) || id.includes('__')) throw new Error(tr("无效的账号 ID"))
    return path.join(this.accountsDir(), id)
  }

  private accountNames(): Record<string, { name?: string; loginAt?: number }> {
    try {
      const j = JSON.parse(fs.readFileSync(this.paths.rememberedAccountsFile, 'utf8')) as Record<string, any>
      return Object.fromEntries(Object.entries(j).map(([id, v]) => [id, { name: v?.auth?.name, loginAt: v?.loginAt }]))
    } catch {
      return {}
    }
  }

  async listAccounts(): Promise<AccioAccount[]> {
    const names = await directoryNames(this.accountsDir())
    const remembered = this.accountNames()
    const out: AccioAccount[] = []
    for (const id of names) {
      if (id === 'guest' || id.startsWith('_')) continue
      const dir = path.join(this.accountsDir(), id)
      if (!(await fsp.stat(dir).catch(() => null))?.isDirectory()) continue
      // Listing does not follow plugin links; write/backup operations retain strict validation.
      const st = await dirStats(dir, true)
      out.push({
        id,
        name: remembered[id]?.name,
        path: dir,
        sizeBytes: st.size,
        conversations: await countConversations(dir),
        agents: await countAgents(dir),
        modifiedAt: st.mtime,
        isCurrent: false,
      })
    }
    // Current = most recent login, falling back to the most recently written account.
    const current = [...out].sort((a, b) => (remembered[b.id]?.loginAt ?? b.modifiedAt) - (remembered[a.id]?.loginAt ?? a.modifiedAt))[0]
    if (current) current.isCurrent = true
    return out.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.modifiedAt - a.modifiedAt)
  }

  async listBackups(): Promise<BackupInfo[]> {
    const out: BackupInfo[] = []
    const accounts = await directoryNames(this.paths.backupDir)
    for (const acc of accounts) {
      const stamps = await directoryNames(path.join(this.paths.backupDir, acc))
      for (const stamp of stamps) {
        const dir = path.join(this.paths.backupDir, acc, stamp)
        try {
          const m = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
          out.push({ id: `${acc}__${stamp}`, path: dir, ...m })
        } catch {
          /* incomplete backup */
        }
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  private backupDir(id: string): string {
    const [acc, stamp, extra] = id.split('__')
    if (!acc || !stamp || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(acc) || !/^[A-Za-z0-9_-]+$/.test(stamp)) throw new Error(tr("无效的备份 ID"))
    const dir = path.join(this.paths.backupDir, acc, stamp)
    for (const candidate of [path.dirname(dir), dir]) {
      if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw new Error(tr("备份路径不能包含符号链接"))
    }
    return dir
  }

  private async checkedBackup(id: string): Promise<{ dir: string; manifest: Manifest }> {
    const dir = this.backupDir(id)
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Manifest
    this.accountDir(manifest.accountId)
    if (manifest.accountId !== id.split('__')[0] || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 0) throw new Error(tr("备份清单无效"))
    const data = path.join(dir, 'data')
    const stat = await fsp.lstat(data)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(tr("备份数据目录无效"))
    const actual = await dirStats(data)
    if (actual.files !== manifest.fileCount) throw new Error(tr("备份文件缺失或数量不符，已停止操作，当前会话未改动"))
    return { dir, manifest }
  }

  async backup(accountId: string, reason: BackupInfo['reason'] = 'manual', note?: string): Promise<BackupInfo> {
    const src = this.accountDir(accountId)
    if (!(await exists(src))) throw new Error(tr("账号目录不存在：{0}", accountId))
    const sourceStat = await fsp.lstat(src)
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(tr("账号目录无效或为符号链接"))
    const createdAt = Date.now()
    const stamp = `${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`
    const dir = path.join(this.paths.backupDir, accountId, stamp)
    const data = path.join(dir, 'data')
    await fsp.mkdir(data, { recursive: true })
    const { files, size } = await copyTree(src, data)
    const manifest: Manifest = {
      accountId,
      createdAt,
      sizeBytes: size,
      fileCount: files,
      conversations: await countConversations(data),
      reason,
      note,
    }
    await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return { id: `${accountId}__${stamp}`, path: dir, ...manifest }
  }

  async deleteBackup(id: string): Promise<void> {
    await fsp.rm(this.backupDir(id), { recursive: true, force: true })
  }

  /** Restore a backup over the same account it was taken from. Accio must be closed. */
  async restore(id: string): Promise<{ safetyBackupId: string }> {
    const { dir, manifest } = await this.checkedBackup(id)
    const target = this.accountDir(manifest.accountId)
    await fsp.mkdir(this.accountsDir(), { recursive: true })
    const stage = await fsp.mkdtemp(path.join(this.accountsDir(), '_restore-'))
    const rollback = `${stage}-previous`
    let safetyBackupId = ''
    let moved = false
    try {
      const copied = await copyTree(path.join(dir, 'data'), stage)
      if (copied.files !== manifest.fileCount) throw new Error(tr("备份未完整复制，已停止恢复"))
      await this.paths.beforeWrite?.()
      if (await exists(target)) {
        safetyBackupId = (await this.backup(manifest.accountId, 'before-restore', tr("恢复 {0} 之前自动创建", id))).id
        await this.paths.beforeWrite?.()
        await fsp.rename(target, rollback)
        moved = true
      }
      try { await fsp.rename(stage, target) } catch (e) {
        if (moved) await fsp.rename(rollback, target)
        moved = false
        throw e
      }
      if (moved) await fsp.rm(rollback, { recursive: true, force: true })
    } finally {
      await fsp.rm(stage, { recursive: true, force: true })
    }
    return { safetyBackupId }
  }

  /**
   * Copy the conversation history of a backup into another account. Conversation and
   * message ids embed the last six digits of the owner's user id, so they are rewritten
   * (file contents, file names and SQLite rows) before merging. The target's own data
   * always wins on conflicts, and it is backed up first. Accio must be closed.
   */
  async migrate(backupId: string, targetAccountId: string): Promise<MigrationReport> {
    const { dir, manifest } = await this.checkedBackup(backupId)
    const src = path.join(dir, 'data')
    const oldId = manifest.accountId
    const newId = targetAccountId
    if (oldId === newId) throw new Error(tr("源账号与目标账号相同，请使用「恢复」"))
    const target = this.accountDir(newId)
    if (!(await exists(target))) throw new Error(tr("目标账号目录不存在，请先在 Accio 中登录该账号"))

    const report: MigrationReport = {
      sourceAccountId: oldId,
      targetAccountId: newId,
      safetyBackupId: (await this.backup(newId, 'before-migrate', tr("迁移 {0} 的会话之前自动创建", oldId))).id,
      filesCopied: 0,
      filesSkipped: 0,
      filesRewritten: 0,
      pathsRenamed: 0,
      sqliteRowsMerged: 0,
      warnings: [],
    }

    const staging = path.join(this.paths.backupDir, '_staging', crypto.randomUUID())
    try {
      await copyTree(src, staging, MIGRATE_ITEMS)
      const rewrite = makeRewriter(oldId, newId)
      await rewriteTree(staging, rewrite, report)
      await this.paths.beforeWrite?.()
      try { await mergeTree(staging, target, rewrite, report) } catch (e) {
        report.warnings.push(tr("迁移已中断，目标可能已部分写入：{0}。可恢复保护备份 {1}。", e instanceof Error ? e.message : String(e), report.safetyBackupId))
      }
    } catch (e) {
      throw new Error(tr("迁移准备失败，尚未写入目标账号：{0}。保护备份：{1}", e instanceof Error ? e.message : String(e), report.safetyBackupId))
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
    }
    return report
  }
}

export function makeRewriter(oldId: string, newId: string): (s: string) => string {
  const oldSfx = oldId.slice(-6)
  const newSfx = newId.slice(-6).padStart(6, '0')
  // e.g. CID-00542327U1789692-… : two sequence chars, the six-digit user suffix, then U + seven digits.
  const embedded = /\b([A-Z]{2,4}-[0-9A-F]{2})(\d{6})(U\d{7})/g
  return (s: string) => {
    // This function is only for verified identifier/path fields, never prose.
    let out = s === oldId ? newId : s.split(/([\\/])/).map((part) => part === oldId ? newId : part).join('')
    if (oldSfx !== newSfx) out = out.replace(embedded, (m, a: string, sfx: string, b: string) => (sfx === oldSfx ? `${a}${newSfx}${b}` : m))
    return out
  }
}

const OWNER_FIELD = /^(owner|ownerid|accountid|userid|uid)$/
const REFERENCE_FIELD = /^(id|cid|mid|(?:conversation|message|agent|task|artifact|session|parent|root|request|source|target)(?:id|ids)|path|filepath|relativepath)$/
const CONTENT_FIELD = /^(text|content|title|name|description|prompt|systemprompt|systeminstruction|body|summary|reasoning|thinking|input|output|arguments|args|argsjson|response|responsejson|parameters|parametersjson|metadata)$/
const IDENTIFIER = /^[A-Z]{2,4}-[0-9A-F]{2}\d{6}U\d{7}(?:[-.][A-Za-z0-9_.-]+)*$/

/** Only metadata references are changed. User content and tool payloads are opaque. */
function rewriteRecord(value: unknown, rewrite: (s: string) => string, field = ''): unknown {
  const key = field.replace(/_/g, '').toLowerCase()
  if (CONTENT_FIELD.test(key)) return value
  if (typeof value === 'string') {
    if (OWNER_FIELD.test(key) || REFERENCE_FIELD.test(key)) return rewrite(value)
    if (IDENTIFIER.test(value) && rewrite(value) !== value) throw new Error(tr("未识别的引用字段 {0}，已停止迁移，避免遗漏归属引用", field || '(root)'))
    return value
  }
  if (Array.isArray(value)) return value.map((v) => rewriteRecord(v, rewrite, field))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteRecord(v, rewrite, k)]))
  return value
}

async function rewriteTree(dir: string, rewrite: (s: string) => string, report: MigrationReport): Promise<void> {
  const { DatabaseSync } = await loadSqlite()
  const files: string[] = []
  await walk(dir, (f) => {
    files.push(f)
  })
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    const relative = path.relative(dir, file).split(path.sep)
    // Generated artifacts and skills may contain arbitrary JSON, databases or source code.
    if (['artifacts', 'skills'].includes(relative[0])) continue
    if (SQLITE_EXT.has(ext)) {
      const db = new DatabaseSync(file)
      try {
        db.function('asw_rw', { deterministic: true }, (v: unknown, field: unknown) => rewriteRecord(v, rewrite, String(field)) as string)
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]
        for (const { name } of tables) {
          const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as { name: string; type: string }[]
          for (const c of cols) {
            if (c.type && !/CHAR|CLOB|TEXT/i.test(c.type)) continue
            const q = `"${name.replace(/"/g, '""')}"`
            const col = `"${c.name.replace(/"/g, '""')}"`
            // Unknown columns are checked as well; prose columns remain byte-for-byte intact.
            db.prepare(`UPDATE ${q} SET ${col} = asw_rw(${col}, ?) WHERE typeof(${col}) = 'text' AND ${col} != asw_rw(${col}, ?)`).run(c.name, c.name)
          }
        }
        report.filesRewritten++
      } catch (e) {
        throw new Error(tr("数据库 {0} 重写失败：{1}", path.basename(file), String(e)))
      } finally {
        db.close()
      }
    } else if (STRUCTURED_EXT.has(ext)) {
      const st = await fsp.stat(file)
      if (st.size > 64 * 1024 * 1024) throw new Error(tr("文件 {0} 超过 64 MiB，无法安全检查归属，已停止迁移", path.basename(file)))
      const text = await fsp.readFile(file, 'utf8')
      let next: string
      const rewriteJson = (line: string) => {
        if (!line.trim()) return line
        const parsed: unknown = JSON.parse(line)
        const result = rewriteRecord(parsed, rewrite)
        return JSON.stringify(parsed) === JSON.stringify(result) ? line : JSON.stringify(result)
      }
      try { next = ext === '.jsonl' ? text.split(/(\r?\n)/).map((line) => rewriteJson(line)).join('') : rewriteJson(text) }
      catch (e) { throw new Error(tr("文件 {0} 的结构无法安全迁移：{1}", path.basename(file), e instanceof Error ? e.message : String(e))) }
      if (next !== text) {
        await fsp.writeFile(file, next)
        report.filesRewritten++
      }
    } else if (['.jsonc', '.leaf', '.recovery', '.sink-migrated', ''].includes(ext)) {
      const st = await fsp.stat(file)
      if (st.size > 64 * 1024 * 1024) throw new Error(tr("文件 {0} 过大，无法安全检查归属", path.basename(file)))
      const text = await fsp.readFile(file, 'utf8')
      if (rewrite(text) !== text) throw new Error(tr("文件 {0} 含归属引用但格式尚未支持，请保留备份；本次未写入目标账号", path.basename(file)))
    }
  }
  // Rename deepest paths first so parents stay valid.
  const all: string[] = []
  const collect = async (d: string) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) await collect(full)
      all.push(full)
    }
  }
  await collect(dir)
  for (const p of all.sort((a, b) => b.length - a.length)) {
    const base = path.basename(p)
    const renamed = IDENTIFIER.test(base) ? rewrite(base) : base
    if (renamed !== base) {
      await fsp.rename(p, path.join(path.dirname(p), renamed))
      report.pathsRenamed++
    }
  }
}

async function mergeTree(staging: string, target: string, _rewrite: (s: string) => string, report: MigrationReport): Promise<void> {
  const { DatabaseSync } = await loadSqlite()
  await walk(staging, async (file) => {
    const rel = path.relative(staging, file)
    const dest = path.join(target, rel)
    if (!(await exists(dest))) {
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.copyFile(file, dest)
      report.filesCopied++
      return
    }
    if (['artifacts', 'skills'].includes(rel.split(path.sep)[0]) || !SQLITE_EXT.has(path.extname(file).toLowerCase())) {
      report.filesSkipped++
      return
    }
    // Both sides have this database: insert the source rows that the target lacks.
    const db = new DatabaseSync(dest)
    let inserted = 0
    try {
      db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS src`)
      const tables = db.prepare(`SELECT name, sql FROM src.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string; sql: string }[]
      db.exec('BEGIN')
      for (const t of tables) {
        const q = `"${t.name.replace(/"/g, '""')}"`
        const present = db.prepare(`SELECT 1 FROM main.sqlite_master WHERE type='table' AND name = ?`).get(t.name)
        if (!present) db.exec(t.sql)
        const srcCols = (db.prepare(`PRAGMA src.table_info(${q})`).all() as { name: string }[]).map((c) => c.name)
        const dstCols = new Set((db.prepare(`PRAGMA main.table_info(${q})`).all() as { name: string }[]).map((c) => c.name))
        const cols = srcCols.filter((c) => dstCols.has(c)).map((c) => `"${c.replace(/"/g, '""')}"`)
        if (!cols.length) continue
        const r = db.prepare(`INSERT OR IGNORE INTO main.${q} (${cols.join(',')}) SELECT ${cols.join(',')} FROM src.${q}`).run()
        inserted += Number(r.changes)
      }
      db.exec('COMMIT')
      report.sqliteRowsMerged += inserted
    } catch (e) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* not in a transaction */
      }
      throw new Error(tr("合并数据库 {0} 失败：{1}", rel, String(e)))
    } finally {
      try {
        db.exec('DETACH DATABASE src')
      } catch {
        /* ignore */
      }
      db.close()
    }
  })
}
