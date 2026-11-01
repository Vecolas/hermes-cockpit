import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Preview puro no navegador (sem Electron): `npm run dev:web -- --port 7100`.
// Nesse modo não há bridge do main process — a tela de conexão pede URL + token.
export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react(), tailwindcss()],
  server: { host: true, port: Number(process.env.PORT) || 5173, strictPort: false },
  build: { outDir: resolve('out/web'), emptyOutDir: true },
})
