import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain, type WebContents } from 'electron'

// Shell de verdade para o Terminal do dock (o /api/pty do serve só roda
// `hermes --tui`). Sem dependência nativa: um relay de PTY em Python stdlib
// (pty.fork + select) faz a ponte stdin/stdout ↔ zsh, e entende o mesmo frame
// de resize do Hermes: "\x1b[RESIZE:<cols>;<rows>]".
//
// Canais (domínio ops — o preload só aceita swarm|ops|storage|transcriber):
//   ops:shell.open(id, {cwd?, cols, rows}) · ops:shell.write(id, data)
//   ops:shell.resize(id, cols, rows) · ops:shell.close(id)
// Eventos para o webContents dono: ops:shell.data {id, data: Uint8Array}
//   e ops:shell.exit {id, code}.

const RELAY = String.raw`
import os, pty, re, select, signal, struct, sys, fcntl, termios
cols, rows, cwd = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
cmd = sys.argv[4] if len(sys.argv) > 4 else ''
shell = os.environ.get('SHELL') or '/bin/zsh'
pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(cwd)
    except Exception:
        pass
    os.environ['TERM'] = 'xterm-256color'
    if cmd:
        os.execvp(shell, [shell, '-lc', cmd])
    os.execvp(shell, [shell, '-l'])
def setsize(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
        os.kill(pid, signal.SIGWINCH)
    except Exception:
        pass
setsize(cols, rows)
RES = re.compile(rb'\x1b\[RESIZE:(\d+);(\d+)\]')
out = sys.stdout.fileno()
while True:
    try:
        r, _, _ = select.select([fd, 0], [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(out, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            break
        def _res(m):
            setsize(int(m.group(1)), int(m.group(2)))
            return b''
        data = RES.sub(_res, data)
        if data:
            os.write(fd, data)
try:
    os.kill(pid, signal.SIGHUP)
except Exception:
    pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`

const PY_CANDIDATES = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']
const MAX_SESSIONS = 12
const ID_RE = /^[\w.:-]{1,80}$/

interface Sess {
  child: ChildProcess
  owner: WebContents
}
const sessions = new Map<string, Sess>()
let relayPath: string | null = null

function ensureRelay(): string {
  if (relayPath && existsSync(relayPath)) return relayPath
  const dir = join(app.getPath('userData'), 'shell')
  mkdirSync(dir, { recursive: true })
  relayPath = join(dir, 'pty-relay.py')
  writeFileSync(relayPath, RELAY, { mode: 0o600 })
  return relayPath
}

function python(): string {
  const py = PY_CANDIDATES.find((p) => existsSync(p))
  if (!py) throw new Error('python3 não encontrado (necessário para o shell do terminal)')
  return py
}

function safeCwd(cwd: unknown): string {
  if (typeof cwd === 'string' && cwd.startsWith('/')) {
    try {
      if (statSync(cwd).isDirectory()) return cwd
    } catch {
      /* cai no home */
    }
  }
  return homedir()
}

const clampDim = (n: unknown, lo: number, hi: number, dflt: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt

function kill(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.child.stdin?.end()
    s.child.kill('SIGTERM')
  } catch {
    /* já morto */
  }
}

export function stopAllShells(): void {
  for (const id of [...sessions.keys()]) kill(id)
}

export function register(): void {
  ipcMain.handle('ops:shell.open', (e, id: unknown, opts: { cwd?: unknown; cols?: unknown; rows?: unknown; cmd?: unknown } = {}) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('id de shell inválido')
    if (sessions.has(id)) kill(id)
    if (sessions.size >= MAX_SESSIONS) throw new Error(`limite de ${MAX_SESSIONS} shells abertos`)
    const cols = clampDim(opts.cols, 10, 500, 80)
    const rows = clampDim(opts.rows, 3, 300, 24)
    const env: NodeJS.ProcessEnv = { ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' }
    delete env.ELECTRON_RUN_AS_NODE
    // cmd opcional: roda via `$SHELL -lc` (ex.: acompanhar/retomar uma instância do swarm)
    const cmd = typeof opts.cmd === 'string' ? opts.cmd.slice(0, 4000) : ''
    const child = spawn(python(), [ensureRelay(), String(cols), String(rows), safeCwd(opts.cwd), ...(cmd ? [cmd] : [])], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const owner = e.sender
    sessions.set(id, { child, owner })
    const send = (ch: string, payload: unknown) => {
      if (!owner.isDestroyed()) owner.send(ch, payload)
    }
    child.stdout?.on('data', (b: Buffer) => send('ops:shell.data', { id, data: new Uint8Array(b) }))
    child.stderr?.on('data', (b: Buffer) => send('ops:shell.data', { id, data: new Uint8Array(b) }))
    child.once('exit', (code) => {
      if (sessions.get(id)?.child === child) sessions.delete(id)
      send('ops:shell.exit', { id, code })
    })
    child.once('error', (err) => send('ops:shell.data', { id, data: new TextEncoder().encode(`\r\n${err.message}\r\n`) }))
    owner.once('destroyed', () => kill(id))
    return { ok: true }
  })
  ipcMain.handle('ops:shell.write', (_e, id: unknown, data: unknown) => {
    const s = typeof id === 'string' ? sessions.get(id) : undefined
    if (!s || typeof data !== 'string') return
    s.child.stdin?.write(data)
  })
  ipcMain.handle('ops:shell.resize', (_e, id: unknown, cols: unknown, rows: unknown) => {
    const s = typeof id === 'string' ? sessions.get(id) : undefined
    if (!s) return
    s.child.stdin?.write(`\x1b[RESIZE:${clampDim(cols, 10, 500, 80)};${clampDim(rows, 3, 300, 24)}]`)
  })
  ipcMain.handle('ops:shell.close', (_e, id: unknown) => {
    if (typeof id === 'string') kill(id)
  })
}
