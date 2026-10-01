// Renders the app icon SVG to PNG/ICO with Electron's offscreen renderer.
// Usage: npx electron scripts/make-icons.mjs
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const out = path.resolve('resources')

const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7C6CFF"/>
      <stop offset="0.55" stop-color="#9B5CF6"/>
      <stop offset="1" stop-color="#FF7A59"/>
    </linearGradient>
    <radialGradient id="shine" cx="0.3" cy="0.2" r="0.9">
      <stop offset="0" stop-color="#fff" stop-opacity="0.35"/>
      <stop offset="0.6" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="knob" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#EDE9FE"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#2E1065" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#bg)"/>
  <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#shine)"/>
  <rect x="96" y="176" width="320" height="160" rx="80" fill="#FFFFFF" fill-opacity="0.22" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="10"/>
  <circle cx="178" cy="256" r="26" fill="#FFFFFF" fill-opacity="0.55"/>
  <g filter="url(#shadow)">
    <circle cx="336" cy="256" r="64" fill="url(#knob)"/>
  </g>
  <path d="M344 222 L318 262 H340 L328 292 L356 250 H334 Z" fill="#8B5CF6"/>
</svg>`

function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2)
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)])
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true })
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const render = async (size) => {
    win.setContentSize(size, size)
    const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg(size)}</body></html>`
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    await new Promise((r) => setTimeout(r, 150))
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
    return img.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const pngs = []
  for (const size of sizes) pngs.push({ size, data: await render(size) })
  fs.writeFileSync(path.join(out, 'icon.ico'), ico(pngs))
  fs.writeFileSync(path.join(out, 'icon.png'), await render(512))
  fs.writeFileSync(path.join(out, 'tray.png'), pngs.find((p) => p.size === 32).data)
  fs.writeFileSync(path.join(out, 'icon.svg'), svg(512))
  console.log('icons written to', out)
  app.quit()
})
