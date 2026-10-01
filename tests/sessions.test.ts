import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import { SessionManager, makeRewriter } from '../src/main/sessions.ts'

const OLD = '1111222333'
const NEW = '9999888777'
const OLD_CID = 'CID-00222333U1789692-AAA525-1013-9330D2'
const NEW_CID = 'CID-00888777U1789692-AAA525-1013-9330D2'
const TARGET_CID = 'CID-05888777U1790000-AAA525-2000-111111'
const PROSE = `Invoice ${OLD}; quoted reference ${OLD_CID}`

let root = ''
let mgr: SessionManager

function write(p: string, content: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

function makeDb(file: string, rows: [string, string][]) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE IF NOT EXISTS conversations (conversation_id TEXT PRIMARY KEY, title TEXT, path TEXT, created_at INTEGER NOT NULL DEFAULT 0)')
  for (const [id, title] of rows) db.prepare('INSERT INTO conversations (conversation_id, title, path) VALUES (?, ?, ?)').run(id, title, `dm/${id}.json`)
  db.close()
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-sessions-'))
  const acc = path.join(root, '.accio', 'accounts')
  const oldDir = path.join(acc, OLD)
  write(path.join(oldDir, 'conversations', 'dm', `${OLD_CID}.json`), JSON.stringify({ id: OLD_CID, owner: OLD, title: PROSE, content: { id: OLD_CID, text: PROSE }, text: PROSE }))
  write(path.join(oldDir, 'conversations', 'dm', `${OLD_CID}.message_1.jsonl`), `{"cid":"${OLD_CID}","mid":"MID-01222333U1789690-AAA525-5131-784E9E"}\n`)
  write(path.join(oldDir, 'agents', 'MID-01222333U1789690-AAA525-5131-784E9E', 'profile.json'), '{"name":"Agent"}')
  write(path.join(oldDir, 'settings-local.json'), '{"not":"migrated"}')
  makeDb(path.join(oldDir, 'conversations', 'conv-index.db'), [[OLD_CID, PROSE]])
  write(path.join(oldDir, 'artifacts', 'example.json'), JSON.stringify({ owner: OLD, id: OLD_CID, text: PROSE }))
  write(path.join(oldDir, 'skills', 'example.md'), PROSE)
  makeDb(path.join(oldDir, 'artifacts', 'example.db'), [[OLD_CID, PROSE]])

  const newDir = path.join(acc, NEW)
  write(path.join(newDir, 'conversations', 'dm', `${TARGET_CID}.json`), JSON.stringify({ id: TARGET_CID, title: '新账号自己的会话' }))
  makeDb(path.join(newDir, 'conversations', 'conv-index.db'), [[TARGET_CID, '新账号自己的会话']])

  write(path.join(root, 'remembered.json'), JSON.stringify({ [NEW]: { auth: { name: '新号' }, loginAt: 2 }, [OLD]: { auth: { name: '旧号' }, loginAt: 1 } }))
  mgr = new SessionManager({ accioDir: path.join(root, '.accio'), backupDir: path.join(root, 'backups'), rememberedAccountsFile: path.join(root, 'remembered.json') })
})

after(() => fs.rmSync(root, { recursive: true, force: true }))

describe('session manager', () => {
  it('rewrites identifiers and account path segments without replacing prose account numbers', () => {
    const rw = makeRewriter(OLD, NEW)
    assert.equal(rw(OLD_CID), NEW_CID)
    assert.equal(rw(OLD), NEW)
    assert.equal(rw(`accounts/${OLD}/${OLD_CID}.json`), `accounts/${NEW}/${NEW_CID}.json`)
    assert.equal(rw(`Invoice ${OLD}`), `Invoice ${OLD}`)
    assert.equal(rw('CID-00999999U1789692-X'), 'CID-00999999U1789692-X')
    assert.equal(rw('price 222333 yuan'), 'price 222333 yuan')
  })

  it('lists accounts with names and current flag', async () => {
    const list = await mgr.listAccounts()
    assert.equal(list.length, 2)
    assert.equal(list[0].id, NEW)
    assert.equal(list[0].isCurrent, true)
    assert.equal(list[0].name, '新号')
    assert.equal(list.find((a) => a.id === OLD)?.conversations, 1)
    const link = path.join(root, '.accio', 'accounts', OLD, 'linked-plugin')
    const linkedTarget = path.join(root, 'plugin-target')
    fs.mkdirSync(linkedTarget)
    fs.symlinkSync(linkedTarget, link, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      assert.equal((await mgr.listAccounts()).length, 2, 'listing skips linked plugin contents')
      await assert.rejects(mgr.backup(OLD), /不支持符号链接/, 'backup must still refuse linked contents')
    } finally { fs.unlinkSync(link) }
  })

  it('backs up and migrates conversations into another account', async () => {
    const b = await mgr.backup(OLD)
    assert.equal(b.conversations, 1)
    const report = await mgr.migrate(b.id, NEW)
    assert.deepEqual(report.warnings, [])
    assert.ok(report.safetyBackupId.startsWith(`${NEW}__`))

    const dm = path.join(root, '.accio', 'accounts', NEW, 'conversations', 'dm')
    const names = fs.readdirSync(dm).sort()
    assert.ok(names.includes(`${NEW_CID}.json`), names.join(','))
    assert.ok(names.includes(`${TARGET_CID}.json`))
    assert.ok(!names.some((n) => n.includes('222333')))
    const conv = JSON.parse(fs.readFileSync(path.join(dm, `${NEW_CID}.json`), 'utf8'))
    assert.equal(conv.owner, NEW)
    assert.equal(conv.title, PROSE)
    assert.equal(conv.text, PROSE)
    assert.deepEqual(conv.content, { id: OLD_CID, text: PROSE })
    for (const rel of ['artifacts/example.json', 'skills/example.md']) {
      assert.deepEqual(fs.readFileSync(path.join(root, '.accio', 'accounts', NEW, rel)), fs.readFileSync(path.join(root, '.accio', 'accounts', OLD, rel)))
    }
    // SQLite's online backup changes page counters, so verify artifact records rather than file bytes.
    const artifactDb = new DatabaseSync(path.join(root, '.accio', 'accounts', NEW, 'artifacts', 'example.db'), { readOnly: true })
    try {
      assert.deepEqual({ ...artifactDb.prepare('SELECT conversation_id, title, path FROM conversations').get() }, { conversation_id: OLD_CID, title: PROSE, path: `dm/${OLD_CID}.json` })
    } finally { artifactDb.close() }
    assert.match(fs.readFileSync(path.join(dm, `${NEW_CID}.message_1.jsonl`), 'utf8'), /MID-01888777U1789690/)
    assert.ok(fs.existsSync(path.join(root, '.accio', 'accounts', NEW, 'agents', 'MID-01888777U1789690-AAA525-5131-784E9E', 'profile.json')))
    assert.ok(!fs.existsSync(path.join(root, '.accio', 'accounts', NEW, 'settings-local.json')))

    const db = new DatabaseSync(path.join(root, '.accio', 'accounts', NEW, 'conversations', 'conv-index.db'), { readOnly: true })
    const rows = db.prepare('SELECT conversation_id, path, title FROM conversations ORDER BY conversation_id').all() as any[]
    db.close()
    assert.deepEqual(
      rows.map((r) => r.conversation_id),
      [TARGET_CID, NEW_CID].sort(),
    )
    assert.equal(rows.find((r) => r.conversation_id === NEW_CID).path, `dm/${NEW_CID}.json`)
    assert.equal(rows.find((r) => r.conversation_id === NEW_CID).title, PROSE)
    assert.equal(report.sqliteRowsMerged, 1)
  })

  it('restores a backup and keeps a safety copy', async () => {
    const before = (await mgr.listBackups()).length
    const newBackup = (await mgr.listBackups()).find((b) => b.accountId === NEW && b.reason === 'before-migrate')!
    const { safetyBackupId } = await mgr.restore(newBackup.id)
    assert.ok(safetyBackupId)
    const dm = path.join(root, '.accio', 'accounts', NEW, 'conversations', 'dm')
    assert.ok(!fs.readdirSync(dm).includes(`${NEW_CID}.json`), 'restore should roll the migration back')
    assert.equal((await mgr.listBackups()).length, before + 1)
  })

  it('rejects a missing backup file and path traversal before changing the account', async () => {
    const b = await mgr.backup(OLD)
    const file = path.join(root, '.accio', 'accounts', OLD, 'settings-local.json')
    const original = fs.readFileSync(file, 'utf8')
    const unreadable = new SessionManager({ accioDir: path.join(root, '.accio'), backupDir: file, rememberedAccountsFile: '' })
    await assert.rejects(unreadable.listBackups(), /ENOTDIR/)
    // The isolated fixture loses one file; restoration must not touch the live fixture.
    fs.unlinkSync(path.join(b.path, 'data', 'settings-local.json'))
    await assert.rejects(mgr.restore(b.id), /备份文件缺失/)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    await assert.rejects(mgr.backup('../outside'), /无效的账号 ID/)
    await assert.rejects(mgr.deleteBackup('a__x/y'), /无效的备份 ID/)
  })

  it('stops unknown reference fields before writing the target account', async () => {
    const source = path.join(root, '.accio', 'accounts', OLD, 'conversations', 'unknown.json')
    const original = JSON.stringify({ futureReference: OLD_CID })
    write(source, original)
    try {
      const b = await mgr.backup(OLD)
      await assert.rejects(mgr.migrate(b.id, NEW), /尚未写入目标账号.*未识别的引用字段/)
      assert.equal(fs.readFileSync(source, 'utf8'), original)
      assert.equal(fs.existsSync(path.join(root, '.accio', 'accounts', NEW, 'conversations', 'unknown.json')), false)
    } finally { fs.unlinkSync(source) }
  })
})
