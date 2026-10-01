import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: {
      rollupOptions: { external: ['node:sqlite'] },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    build: { minify: 'esbuild', target: 'chrome140' },
    resolve: {
      alias: { '@': resolve('src/renderer/src') },
    },
    plugins: [react(), tailwindcss()],
  },
})
