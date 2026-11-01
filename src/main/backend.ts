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
  // Herdados de um Hermes Desktop pai: não podem vazar para o nosso filho
  // (o watchdog do serve usaria o PID errado).
  delete env.HERMES_PARENT_START_MARKER
  delete env.HERMES_PARENT_NONCE
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
let shuttingDown = false
// Todo filho vivo (inclusive um que ainda não deu ready) — o lifecycle mata
// todos, não só o `current`.
const children = new Set<ChildProcess>()

export function ensureBackend(): Promise<BackendInfo> {
  if (shuttingDown) return Promise.reject(new Error('app encerrando: backend indisponível'))
  if (current) return Promise.resolve(current.info)
  if (starting) return starting
  starting = start().finally(() => {
    starting = null
  })
  return starting
}

export function hasBackend(): boolean {
  return children.size > 0
}

// O serve é spawnado com detached:true → vira líder do próprio grupo de
// processos. Sinal em -pid alcança o serve e qualquer filho dele (PTYs,
// shells de ferramenta). Fallback: o próprio filho.
function signalChild(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) return
  try {
    process.kill(-pid, sig)
    return
  } catch {
    /* grupo já sumiu ou não é líder — tenta o pid direto */
  }
  try {
    child.kill(sig)
  } catch {
    /* já morto */
  }
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

function start(): Promise<BackendInfo> {
  return new Promise((resolve, reject) => {
    // O token de sessão é nosso: o serve o aceita via env. Fica só no main —
    // o renderer recebe a info mascarada (ver index.ts).
    const token = randomBytes(24).toString('base64url')
    const child = spawn(resolveHermesBin(), ['serve', '--host', '127.0.0.1', '--port', '0'], {
      env: {
        ...childEnv(),
        HERMES_DASHBOARD_SESSION_TOKEN: token,
        // Watchdog nativo do serve (hermes_cli/web_server_lifecycle.py): se
        // este main morrer sem cerimônia (SIGKILL, crash), o serve percebe o
        // PID sumir e sai sozinho em ~2s. Modo só-PID (sem start marker).
        HERMES_PARENT_PID: String(process.pid),
      },
      // App aberto pelo Finder herda cwd '/'; /api/fs/default-cwd devolve o
      // cwd do serve, então ancora no HOME.
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    children.add(child)

    let buffer = ''
    let ready = false
    const tail = () => buffer.slice(-2000)
    const timer = setTimeout(() => {
      signalChild(child, 'SIGKILL')
      reject(new Error(`hermes serve não respondeu em ${SPAWN_TIMEOUT_MS / 1000}s.\n${tail()}`))
    }, SPAWN_TIMEOUT_MS)

    // Continua drenando stdout/stderr depois do ready (pipe cheio trava o
    // filho); guarda só uma cauda para diagnóstico.
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 64_000) buffer = buffer.slice(-32_000)
      if (ready) return
      const m = buffer.match(READY_RE)
      if (!m) return
      ready = true
      clearTimeout(timer)
      const port = Number(m[1])
      const info: BackendInfo = {
        baseUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`,
        token,
        pid: child.pid ?? 0,
      }
      if (shuttingDown) {
        signalChild(child, 'SIGTERM')
        reject(new Error('app encerrando: backend descartado'))
        return
      }
      current = { child, info }
      resolve(info)
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', (err) => {
      clearTimeout(timer)
      children.delete(child)
      reject(new Error(`falha ao iniciar "hermes serve": ${err.message}`))
    })
    child.once('exit', (code, signal) => {
      children.delete(child)
      clearTimeout(timer)
      if (current?.child === child) {
        // Morreu depois do ready: o próximo ensureBackend() sobe outro.
        current = null
        return
      }
      if (!ready) reject(new Error(`hermes serve encerrou antes do ready (código ${code ?? signal}).\n${tail()}`))
    })
  })
}

// Proxy REST pelo main process: evita CORS (o serve não emite Access-Control-*)
// e mantém o token fora do renderer para REST.
export interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** serializado como JSON */
  body?: unknown
}

export async function apiFetch(path: string, init: ApiInit = {}): Promise<unknown> {
  // Só o pathname é validado contra '..' — a query pode carregar nomes de
  // arquivo legítimos ('a..b.txt'); o serve valida os próprios parâmetros.
  const pathname = typeof path === 'string' ? path.split(/[?#]/, 1)[0] : ''
  if (typeof path !== 'string' || !pathname.startsWith('/api/') || /\.\.|%2e%2e/i.test(pathname)) {
    throw new Error(`caminho REST inválido: ${String(path).slice(0, 120)}`)
  }
  const info = await ensureBackend()
  const method = init.method ?? 'GET'
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`método inválido: ${method}`)
  const headers: Record<string, string> = { 'x-hermes-session-token': info.token }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${info.baseUrl}${path}`, {
    method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Para o backend de forma síncrona (best-effort): sinaliza o grupo e esquece.
 * Usado em will-quit / process 'exit', onde não dá para esperar.
 * Também impede novos spawns.
 */
export function stopBackend(sig: NodeJS.Signals = 'SIGTERM'): void {
  shuttingDown = true
  for (const child of children) if (isAlive(child)) signalChild(child, sig)
  current = null
}

/**
 * Parada graciosa: SIGTERM no grupo (o serve tem flush-on-kill de transcripts),
 * espera até `graceMs` e escala para SIGKILL. Resolve quando todos saíram.
 */
export async function stopBackendGracefully(graceMs = 2500): Promise<void> {
  shuttingDown = true
  const alive = [...children].filter(isAlive)
  current = null
  if (alive.length === 0) return
  const exits = alive.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (!isAlive(child)) return resolve()
        child.once('exit', () => resolve())
      }),
  )
  for (const child of alive) signalChild(child, 'SIGTERM')
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    Promise.all(exits).then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), graceMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (timedOut) {
    for (const child of alive) if (isAlive(child)) signalChild(child, 'SIGKILL')
    // espera curta pelo SIGKILL ser entregue
    await Promise.race([Promise.all(exits), new Promise((r) => setTimeout(r, 500))])
  }
}
