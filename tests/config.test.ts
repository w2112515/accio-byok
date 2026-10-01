import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { ConfigStore, type SecretBox } from '../src/main/config.ts'

const box: SecretBox = { available: () => true, encrypt: (s) => `test:${s}`, decrypt: (s) => {
  if (!s.startsWith('test:')) throw new Error('cannot decrypt')
  return s.slice(5)
} }

it('restores a readable configuration safely and preserves the current file on invalid recovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-config-restore-'))
  const file = path.join(root, 'config.json')
  try {
    const store = new ConfigStore(file, box)
    const saved = store.saveProvider({ name: 'Original', kind: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'original-key', model: 'm', modelOverrides: {} }, true)
    store.updateSettings({ autoBackup: true, launchAccioOnStart: true })
    const snapshot = fs.readFileSync(file, 'utf8')
    store.saveProvider({ ...saved, apiKey: 'replacement-key', name: 'Changed' })
    const current = fs.readFileSync(file, 'utf8')
    assert.throws(() => store.restoreSnapshot('{broken'))
    assert.equal(fs.readFileSync(file, 'utf8'), current)
    store.restoreSnapshot(snapshot)
    assert.equal(store.activeProviderId, 'official')
    assert.equal(store.settings.autoBackup, false)
    assert.equal(store.settings.launchAccioOnStart, false)
    assert.equal(store.provider(saved.id)?.apiKey, 'original-key')
    const protection = fs.readdirSync(root).find((name) => name.includes('.before-restore-'))!
    assert.equal(fs.readFileSync(path.join(root, protection), 'utf8'), current)
    assert.equal(new ConfigStore(file, box).provider(saved.id)?.name, 'Original')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('migrates legacy extra headers into encrypted storage and preserves them across edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-headers-'))
  const file = path.join(root, 'config.json')
  const cipher: SecretBox = { available: () => true, encrypt: (s) => Buffer.from(s).toString('base64'), decrypt: (s) => Buffer.from(s, 'base64').toString() }
  try {
    const store = new ConfigStore(file, cipher)
    const saved = store.saveProvider({ name: 'Mock', kind: 'openai', baseUrl: 'http://127.0.0.1/v1', model: 'm', modelOverrides: {}, extraHeaders: { 'X-Relay-Key': 'header-secret' } })
    assert.equal(saved.extraHeaders?.['X-Relay-Key'], 'header-secret')
    assert.ok(!fs.readFileSync(file, 'utf8').includes('header-secret'))
    assert.ok(!('encryptedHeaders' in saved))
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    delete raw.providers[0].encryptedHeaders
    raw.providers[0].extraHeaders = { 'X-Legacy-Key': 'old-secret' }
    fs.writeFileSync(file, JSON.stringify(raw))
    const reopened = new ConfigStore(file, cipher)
    assert.equal(reopened.provider(saved.id)?.extraHeaders?.['X-Legacy-Key'], 'old-secret')
    reopened.updateSettings({ theme: 'dark' })
    assert.ok(!fs.readFileSync(file, 'utf8').includes('old-secret'))
    const next = new ConfigStore(file, cipher)
    next.saveProvider({ ...saved, extraHeaders: undefined, name: 'Renamed' })
    assert.equal(next.provider(saved.id)?.extraHeaders?.['X-Legacy-Key'], 'old-secret')
    next.saveProvider({ ...saved, extraHeaders: {} })
    assert.deepEqual(next.provider(saved.id)?.extraHeaders, undefined)
    const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
    legacy.settings.upstreamGateway = 'http://gateway.invalid'
    fs.writeFileSync(file, JSON.stringify(legacy))
    const insecure = new ConfigStore(file, cipher)
    assert.equal(insecure.loadError, undefined, 'old HTTP setting remains editable')
    assert.equal(insecure.providerViews().length, 1, 'upgrade preserves providers')
    assert.throws(() => insecure.updateSettings({ theme: 'light' }), /必须使用 HTTPS/)
    insecure.updateSettings({ upstreamGateway: 'https://gateway.invalid' })
    assert.equal(new ConfigStore(file, cipher).providerViews().length, 1)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('preserves corrupt configuration until explicit recovery keeps a copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-config-'))
  const file = path.join(root, 'config.json')
  const broken = '{"providers":[broken'
  fs.writeFileSync(file, broken)
  try {
    const store = new ConfigStore(file, box)
    assert.ok(store.loadError)
    assert.throws(() => store.updateSettings({ theme: 'dark' }), /原文件已保留/)
    assert.throws(() => store.resolveTarget(), /配置读取失败/)
    assert.equal(fs.readFileSync(file, 'utf8'), broken)
    store.recover('reset')
    const backup = fs.readdirSync(root).find((n) => n.endsWith('.bak'))!
    assert.equal(fs.readFileSync(path.join(root, backup), 'utf8'), broken)
    assert.equal(new ConfigStore(file, box).loadError, undefined)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

it('reports a stored key that cannot decrypt and permits replacing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asw-key-'))
  const file = path.join(root, 'config.json')
  try {
    const store = new ConfigStore(file, box)
    const input = { name: 'Mock', kind: 'openai' as const, baseUrl: 'http://127.0.0.1/v1', model: 'm', apiKey: 'new-key', modelOverrides: {} }
    const saved = store.saveProvider(input, true)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.providers[0].apiKey = 'unreadable'
    fs.writeFileSync(file, JSON.stringify(raw))
    const reopened = new ConfigStore(file, box)
    assert.match(reopened.providerViews()[0].keyError!, /无法解密/)
    assert.throws(() => reopened.resolveTarget(), /无法解密/)
    reopened.saveProvider({ ...input, id: saved.id }, true)
    assert.equal(reopened.provider(saved.id)?.apiKey, 'new-key')
    assert.equal(new ConfigStore(file, box).activeProviderId, saved.id)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
