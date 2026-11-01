import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function cliFlag(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.split('=')[1]
  const i = process.argv.findIndex((a) => a === `--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

const devPort = Number(cliFlag('port') ?? process.env.PORT) || 5173
const devHost = cliFlag('host') ?? process.env.HOST ?? '127.0.0.1'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/main' },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'out/preload' },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    server: { host: devHost, port: devPort, strictPort: false },
    build: { outDir: 'out/renderer' },
  },
})
