import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

// App empacotado aberto pelo Finder tem PATH mínimo (/usr/bin:/bin:...) —
// resolve o binário do hermes por caminhos conhecidos antes de cair no PATH.
const HERMES_DIR_CANDIDATES = [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']

function resolveHermesBin(): string {
  if (process.env.HERMES_BIN && existsSync(process.env.HERMES_BIN)) return process.env.HERMES_BIN
  for (const dir of HERMES_DIR_CANDIDATES) {
    const candidate = join(dir, 'hermes')
    if (existsSync(candidate)) return candidate
  }
  return 'hermes'
}

function childEnv(): NodeJS.ProcessEnv {
  const path = [HERMES_DIR_CANDIDATES.join(delimiter), process.env.PATH ?? ''].join(delimiter)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path }
  // Se o app foi lançado de um host Electron (ex.: outro agente), o filho não
  // pode herdar isso — qualquer binário Electron no caminho viraria Node puro.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

// O `hermes serve` anuncia `HERMES_BACKEND_READY port=N` no stdout; o legado
// `hermes dashboard` anuncia HERMES_DASHBOARD_READY. Uvicorn pode emendar o
// sentinel num chunk de stderr — por isso o buffer é MERGED (mesmo padrão do
// backend-ready.ts do app oficial).
const READY_RE = /(?<!\w)HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/
const SPAWN_TIMEOUT_MS = 90_000

export interface BackendInfo {
  baseUrl: string
  wsUrl: string
  token: string
  pid: number
}

let current: { child: ChildProcess; info: BackendInfo } | null = null
let starting: Promise<BackendInfo> | null = null

export function ensureBackend(): Promise<BackendInfo> {
  if (current) return Promise.resolve(current.info)
  if (starting) return starting
  starting = start().finally(() => {
    starting = null
  })
  return starting
}

function start(): Promise<BackendInfo> {
  return new Promise((resolve, reject) => {
    // O token de sessão é nosso: o serve o aceita via env e o renderer usa
    // como ?token= no upgrade do WebSocket e header no REST.
    const token = randomBytes(24).toString('base64url')
    const child = spawn(resolveHermesBin(), ['serve', '--host', '127.0.0.1', '--port', '0'], {
      env: { ...childEnv(), HERMES_DASHBOARD_SESSION_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let buffer = ''
    const tail = () => buffer.slice(-2000)
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* já morto */
      }
      reject(new Error(`hermes serve não respondeu em ${SPAWN_TIMEOUT_MS / 1000}s.\n${tail()}`))
    }, SPAWN_TIMEOUT_MS)

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 64_000) buffer = buffer.slice(-32_000)
      const m = buffer.match(READY_RE)
      if (!m) return
      clearTimeout(timer)
      const port = Number(m[1])
      const info: BackendInfo = {
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`,
        token,
        pid: child.pid ?? 0,
      }
      current = { child, info }
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
      resolve(info)
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`falha ao iniciar "hermes serve": ${err.message}`))
    })
    child.once('exit', (code) => {
      if (current?.child === child) {
        current = null
        return
      }
      clearTimeout(timer)
      reject(new Error(`hermes serve encerrou antes do ready (código ${code}).\n${tail()}`))
    })
  })
}

// Proxy REST pelo main process: evita CORS (o serve não emite Access-Control-*)
// e mantém o token fora do renderer para REST.
export async function apiFetch(path: string): Promise<unknown> {
  const info = await ensureBackend()
  const res = await fetch(`${info.baseUrl}${path}`, {
    headers: { 'x-hermes-session-token': info.token },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function stopBackend(): void {
  if (!current) return
  try {
    current.child.kill()
  } catch {
    /* já morto */
  }
  current = null
}
