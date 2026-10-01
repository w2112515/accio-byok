// Development helper: capture pages or drive a scripted walkthrough. Enabled only when
// ASW_SHOT_DIR is set; never active in normal use.
import type { BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const PAGES = ['总览', '模型接入', '用量与诊断', '会话备份', '设置']

export type Step = { js: string } | { wait: number } | { shot: string } | { viewport: { width: number; height: number; zoom?: number } } | { post: { url: string; body: unknown } }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Helpers injected into the renderer for scenario scripts. */
const HELPERS = `
window.__t = {
  q: (s) => document.querySelector(s),
  btn: (text, root = document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim().includes(text)),
  click: (text, root) => { const b = window.__t.btn(text, root); if (!b) throw new Error('button not found: ' + text); b.click(); return true },
  type: (sel, value) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel
    if (!el) throw new Error('input not found: ' + sel)
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  },
  nav: (label) => window.__t.click(label, document.querySelector('nav')),
  text: () => document.body.innerText,
};
true;
`

export async function captureAll(win: BrowserWindow, dir: string, extra: { name: string; script: string }[] = []): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  await wait(2500)
  const suffix = process.env.ASW_SHOT_SUFFIX ?? ''
  for (const [i, label] of PAGES.entries()) {
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('nav button')].find(b => b.textContent.includes(${JSON.stringify(label)}))?.click()`)
    await wait(1400)
    fs.writeFileSync(path.join(dir, `${i + 1}-${label}${suffix}.png`), (await win.webContents.capturePage()).toPNG())
  }
  for (const { name, script } of extra) {
    await win.webContents.executeJavaScript(script)
    await wait(1200)
    fs.writeFileSync(path.join(dir, `${name}${suffix}.png`), (await win.webContents.capturePage()).toPNG())
  }
}

/** Run a scripted walkthrough; each step's outcome is appended to walk.log in `dir`. */
export async function runScenario(win: BrowserWindow, dir: string, steps: Step[]): Promise<void> {
  fs.mkdirSync(dir, { recursive: true })
  const log = (line: string) => fs.appendFileSync(path.join(dir, 'walk.log'), `${line}\n`)
  await wait(2500)
  await win.webContents.executeJavaScript(HELPERS)
  for (const step of steps) {
    try {
      if ('wait' in step) await wait(step.wait)
      else if ('viewport' in step) {
        win.setSize(step.viewport.width, step.viewport.height)
        win.webContents.setZoomFactor(step.viewport.zoom ?? 1)
        await wait(300)
      }
      else if ('shot' in step) {
        fs.writeFileSync(path.join(dir, `${step.shot}.png`), (await win.webContents.capturePage()).toPNG())
        log(`shot ${step.shot}`)
      } else if ('js' in step) {
        const r = await win.webContents.executeJavaScript(`(async () => { ${step.js} })()`)
        log(`js ok ${r === undefined ? '' : JSON.stringify(r).slice(0, 400)}`)
      } else if ('post' in step) {
        const res = await fetch(step.post.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(step.post.body) })
        const text = await res.text()
        log(`post ${res.status} ${text.slice(0, 300).replace(/\n/g, '\\n')}`)
      }
    } catch (e) {
      log(`ERROR ${JSON.stringify(step).slice(0, 120)} → ${String(e)}`)
    }
  }
}
