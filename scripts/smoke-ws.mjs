#!/usr/bin/env node
// Smoke test do caminho WS que o main process usa (P0-1):
//   1. sobe `hermes serve --host 127.0.0.1 --port 0` com token próprio
//      (mesma lógica de sentinel do src/main/backend.ts);
//   2. conecta com o WebSocket global do Node (sem Origin) em /api/ws?token=;
//   3. chama profiles.list e session.list e imprime contagens;
//   4. mata o serve (grupo de processos) — nada fica órfão.
// Uso: node scripts/smoke-ws.mjs
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const DIRS = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
const READY_RE = /(?<!\w)HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/
const TIMEOUT_MS = 90_000

function resolveHermesBin() {
  if (process.env.HERMES_BIN && existsSync(process.env.HERMES_BIN)) return process.env.HERMES_BIN
  for (const d of DIRS) if (existsSync(join(d, 'hermes'))) return join(d, 'hermes')
  return 'hermes'
}

const token = randomBytes(24).toString('base64url')
const env = { ...process.env, PATH: [DIRS.join(delimiter), process.env.PATH ?? ''].join(delimiter) }
delete env.ELECTRON_RUN_AS_NODE
env.HERMES_DASHBOARD_SESSION_TOKEN = token

const child = spawn(resolveHermesBin(), ['serve', '--host', '127.0.0.1', '--port', '0'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})

let killed = false
function killServe() {
  if (killed || !child.pid) return
  killed = true
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* já morto */
    }
  }
}
process.on('exit', killServe)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

function waitReady() {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`sem sentinel em ${TIMEOUT_MS / 1000}s\n${buf.slice(-2000)}`)), TIMEOUT_MS)
    const onData = (c) => {
      buf += c.toString('utf8')
      const m = buf.match(READY_RE)
      if (!m) return
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.stderr.off('data', onData)
      // continua drenando para o pipe não encher
      child.stdout.resume()
      child.stderr.resume()
      resolve(Number(m[1]))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', (e) => reject(e))
    child.once('exit', (code) => reject(new Error(`serve saiu antes do ready (código ${code})\n${buf.slice(-2000)}`)))
  })
}

function rpcClient(ws) {
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    let f
    try {
      f = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (f.id !== undefined && f.method === undefined) {
      const p = pending.get(String(f.id))
      if (!p) return
      pending.delete(String(f.id))
      f.error ? p.reject(new Error(f.error.message ?? JSON.stringify(f.error))) : p.resolve(f.result)
    } else if (f.id !== undefined && typeof f.method === 'string') {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: f.id, error: { code: -32601, message: 'smoke: no handler' } }))
    }
  })
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = `s${++seq}`
      pending.set(id, { resolve, reject })
      setTimeout(() => pending.has(id) && (pending.delete(id), reject(new Error(`timeout ${method}`))), 20_000)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
}

function countOf(v) {
  if (Array.isArray(v)) return v.length
  if (v && typeof v === 'object') {
    for (const k of ['profiles', 'sessions', 'items', 'results', 'data']) if (Array.isArray(v[k])) return v[k].length
  }
  return `? (${typeof v})`
}

const t0 = Date.now()
try {
  const port = await waitReady()
  console.log(`[smoke] serve pronto pid=${child.pid} port=${port} em ${Date.now() - t0}ms`)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('ws error no upgrade')), { once: true })
    ws.addEventListener('close', (e) => reject(new Error(`ws fechado no upgrade code=${e.code}`)), { once: true })
  })
  console.log('[smoke] ws aberto (WebSocket global do Node, sem Origin)')
  const call = rpcClient(ws)
  const profiles = await call('profiles.list')
  const names = Array.isArray(profiles?.profiles) ? profiles.profiles.map((p) => p?.name ?? p?.id).join(', ') : ''
  console.log(`[smoke] profiles.list -> ${countOf(profiles)} profiles${names ? ` [${names}]` : ''}`)
  const sessions = await call('session.list', { include_hidden: true })
  console.log(`[smoke] session.list -> ${countOf(sessions)} sessões`)
  ws.close()
  console.log('[smoke] OK')
  process.exitCode = 0
} catch (err) {
  console.error(`[smoke] FALHOU: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
} finally {
  killServe()
  // pequeno respiro para o SIGTERM chegar e confirmar que morreu
  await new Promise((r) => setTimeout(r, 800))
  let alive = true
  try {
    process.kill(child.pid, 0)
  } catch {
    alive = false
  }
  if (alive) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* ok */
    }
  }
  console.log(`[smoke] serve encerrado (pid ${child.pid}${alive ? ', precisou SIGKILL' : ''})`)
  process.exit()
}
