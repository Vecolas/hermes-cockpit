// Domínio "transcriber" — ciclo de vida do ~/dev/transcriber (server.py, porta 7100)
// e proxy de TODA a conversa com ele.
//
// Por que proxy pelo main: o server.py (FastAPI) não tem CORSMiddleware, então o
// renderer empacotado (origem file://) não lê respostas de fetch para
// http://127.0.0.1:7100. Tudo passa por aqui: REST via node:http (sem o
// headersTimeout de 300s do fetch do Node — transcrições longas passam disso) e
// o WS de tempo real via WebSocket nativo do Node, retransmitido ao renderer.
//
// CANAIS (renderer → main, via invoke):
//   transcriber:status            → TranscriberStatus
//   transcriber:start             → TranscriberStatus (reutiliza um server já vivo na 7100)
//   transcriber:stop              → TranscriberStatus (só mata o que NÓS subimos)
//   transcriber:logs              → string[] (buffer do filho; vazio se reutilizado)
//   transcriber:devices           → {devices: string[], blackhole: boolean}
//   transcriber:pickFile          → string | null (diálogo nativo; devolve caminho)
//   transcriber:upload(req)       → TranscribeResult   req = {path} | {bytes, name}, + language
//   transcriber:youtube(req)      → TranscribeResult   req = {url, language}
//   transcriber:save(req)         → string | null      req = {name, content} (diálogo salvar)
//   transcriber:liveOpen(req)     → {ok, error?}       req = {id, language, source: mic|system|both}
//   transcriber:liveSend(id,data) → void               data = ArrayBuffer (webm/opus) | string (JSON)
//   transcriber:liveClose(id)     → void
// EVENTOS (main → renderer, via broadcast):
//   transcriber:status            → TranscriberStatus (mudanças de ciclo de vida)
//   transcriber:live              → {id, kind:'state', state, message?} | {id, kind:'msg', msg}
//                                   msg = mensagem JSON do server: {type:'append'|'done'|'error', text?}

import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { request, type IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { BrowserWindow, dialog } from 'electron'
import { broadcast, handle } from './index'

const REPO = join(homedir(), 'dev', 'transcriber')
const SERVER = join(REPO, 'server.py')
const PYTHON = join(REPO, '.venv', 'bin', 'python')
const HOST = '127.0.0.1'
const PORT = 7100
const BASE = `http://${HOST}:${PORT}`
const HEALTH_TIMEOUT_MS = 60_000
const LOG_MAX = 400
// yt-dlp / ffmpeg vêm do Homebrew; app aberto pelo Finder tem PATH mínimo.
const PATH_EXTRA = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin')]

export interface ModelState {
  name: string
  loaded: boolean
  loading: boolean
  error: string | null
}

export interface TranscriberStatus {
  /** ~/dev/transcriber/server.py existe */
  installed: boolean
  /** .venv/bin/python existe */
  venv: boolean
  /** porta 7100 responde como transcriber */
  running: boolean
  /** o processo vivo foi subido por este app */
  ours: boolean
  starting: boolean
  pid?: number
  url: string
  repo: string
  model?: ModelState
  /** porta ocupada por algo que não é o transcriber, saída do filho etc. */
  error?: string
}

export interface TranscribeResult {
  text: string
  language: string | null
  srt: string
}

// ------------------------------------------------------------------ estado ---

let child: ChildProcess | null = null
let starting: Promise<TranscriberStatus> | null = null
let lastError: string | undefined
const logs: string[] = []
const live = new Map<string, WebSocket>()

function pushLog(chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    if (!line.trim()) continue
    logs.push(line)
  }
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX)
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [...PATH_EXTRA, process.env.PATH ?? ''].join(delimiter) }
  delete env.ELECTRON_RUN_AS_NODE
  env.PYTHONUNBUFFERED = '1'
  return env
}

// ------------------------------------------------------------------- http ---

interface HttpResult {
  status: number
  body: string
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    res.on('data', (c: Buffer) => parts.push(c))
    res.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    res.on('error', reject)
  })
}

/** Requisição simples ao server. timeoutMs=0 → sem timeout (transcrição longa). */
function http(
  method: 'GET' | 'POST',
  path: string,
  opts: { timeoutMs?: number; headers?: Record<string, string | number>; write?: (req: ReturnType<typeof request>) => void } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port: PORT, method, path, headers: opts.headers }, (res) => {
      readBody(res).then((body) => resolve({ status: res.statusCode ?? 0, body }), reject)
    })
    if (opts.timeoutMs) {
      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`timeout após ${opts.timeoutMs}ms`)))
    }
    req.on('error', reject)
    if (opts.write) opts.write(req)
    else req.end()
  })
}

/** Erro legível a partir da resposta do FastAPI ({detail}) ou do corpo bruto. */
function httpError(r: HttpResult): Error {
  let detail = r.body.slice(0, 400)
  try {
    const j = JSON.parse(r.body) as { detail?: unknown }
    if (j.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
  } catch {
    /* corpo não-JSON */
  }
  if (r.status === 503) return new Error(`modelo ainda carregando — tente em alguns segundos (${detail})`)
  return new Error(`HTTP ${r.status}: ${detail}`)
}

type Probe =
  | { kind: 'transcriber'; model: ModelState }
  | { kind: 'other'; detail: string }
  | { kind: 'busy'; detail: string } // algo escuta mas não respondeu a tempo (timeout etc.)
  | { kind: 'down' }

async function probe(): Promise<Probe> {
  try {
    const r = await http('GET', '/api/status', { timeoutMs: 1500 })
    if (r.status !== 200) return { kind: 'other', detail: `GET /api/status → HTTP ${r.status}` }
    const j = JSON.parse(r.body) as Partial<ModelState> & { model?: string }
    if (typeof j.loaded !== 'boolean' || typeof j.model !== 'string') {
      return { kind: 'other', detail: 'resposta de /api/status não parece o transcriber' }
    }
    return {
      kind: 'transcriber',
      model: { name: j.model, loaded: j.loaded, loading: Boolean(j.loading), error: (j.error as string | null) ?? null },
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ECONNREFUSED') return { kind: 'down' }
    if (err instanceof SyntaxError) return { kind: 'other', detail: 'porta 7100 responde, mas não com JSON do transcriber' }
    // Timeout/reset: o server pode estar vivo e ocupado (carregando modelo,
    // transcrevendo). Não é 'down' — tratar como down faria spawnar um segundo.
    return { kind: 'busy', detail: err instanceof Error ? err.message : String(err) }
  }
}

// ------------------------------------------------------------- lifecycle ---

async function status(): Promise<TranscriberStatus> {
  const base: TranscriberStatus = {
    installed: existsSync(SERVER),
    venv: existsSync(PYTHON),
    running: false,
    ours: false,
    starting: Boolean(starting),
    url: BASE,
    repo: REPO,
  }
  const p = await probe()
  if (p.kind === 'transcriber') {
    base.running = true
    base.model = p.model
    base.ours = Boolean(child && child.exitCode === null)
    if (base.ours) base.pid = child?.pid
  } else if (p.kind === 'other') {
    base.error = `porta ${PORT} ocupada por outro serviço (${p.detail})`
  } else if (p.kind === 'busy') {
    base.ours = Boolean(child && child.exitCode === null)
    if (base.ours) base.pid = child?.pid
    base.error = `transcriber não respondeu a tempo (ocupado?): ${p.detail}`
  } else if (lastError && !starting) {
    base.error = lastError
  }
  return base
}

async function emitStatus(): Promise<TranscriberStatus> {
  const s = await status()
  broadcast('transcriber:status', s)
  return s
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function doStart(): Promise<TranscriberStatus> {
  lastError = undefined
  const p = await probe()
  if (p.kind === 'transcriber') return { ...(await status()), starting: false } // já vivo (nosso ou de fora): reutiliza
  if (p.kind === 'other') throw new Error(`porta ${PORT} ocupada por outro serviço (${p.detail})`)
  // Nosso server ainda vivo (ou algo ocupando a porta sem responder): esperar,
  // nunca spawnar um segundo — o handle do primeiro se perderia.
  if ((child && child.exitCode === null) || p.kind === 'busy') {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      const h = await probe()
      if (h.kind === 'transcriber') return { ...(await status()), starting: false }
      if (h.kind === 'down' && !(child && child.exitCode === null)) break // morreu: pode spawnar
      await delay(400)
    }
    if (child && child.exitCode === null) throw new Error(`transcriber (pid ${child.pid}) não respondeu em ${HEALTH_TIMEOUT_MS / 1000}s`)
    const again = await probe()
    if (again.kind === 'transcriber') return { ...(await status()), starting: false }
    if (again.kind !== 'down') throw new Error(`porta ${PORT} ocupada e sem resposta do transcriber`)
  }
  if (!existsSync(SERVER)) throw new Error(`transcriber não encontrado em ${REPO}`)
  if (!existsSync(PYTHON)) throw new Error(`venv ausente: ${PYTHON} (veja o README do transcriber)`)

  pushLog(`[cockpit] spawn ${PYTHON} server.py --port ${PORT}`)
  const proc = spawn(PYTHON, ['server.py', '--host', HOST, '--port', String(PORT)], {
    cwd: REPO,
    env: childEnv(),
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child = proc
  proc.stdout?.on('data', (c: Buffer) => pushLog(c.toString('utf8')))
  proc.stderr?.on('data', (c: Buffer) => pushLog(c.toString('utf8')))
  let exited: string | null = null
  proc.on('error', (err) => {
    exited = err.message
    pushLog(`[cockpit] erro no spawn: ${err.message}`)
  })
  proc.on('exit', (code, signal) => {
    exited = `processo saiu (code=${code ?? '-'} signal=${signal ?? '-'})`
    pushLog(`[cockpit] ${exited}`)
    if (child === proc) child = null
    void emitStatus()
  })

  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exited) {
      const tail = logs.slice(-6).join(' | ')
      throw new Error(`transcriber não subiu: ${exited}${tail ? ` — ${tail}` : ''}`)
    }
    const h = await probe()
    if (h.kind === 'transcriber') return { ...(await status()), starting: false }
    await delay(400)
  }
  killChild()
  throw new Error(`transcriber não respondeu em ${HEALTH_TIMEOUT_MS / 1000}s na porta ${PORT}`)
}

async function start(): Promise<TranscriberStatus> {
  if (!starting) {
    starting = doStart()
      .catch((err: unknown) => {
        lastError = err instanceof Error ? err.message : String(err)
        throw err
      })
      .finally(() => {
        starting = null
        void emitStatus()
      })
    void emitStatus()
  }
  return starting
}

function killChild(): void {
  const proc = child
  if (!proc || proc.exitCode !== null) return
  proc.kill('SIGTERM')
  const t = setTimeout(() => {
    if (proc.exitCode === null) proc.kill('SIGKILL')
  }, 3000)
  t.unref()
}

function closeAllLive(): void {
  for (const [id, ws] of live) {
    try {
      ws.close()
    } catch {
      /* já fechado */
    }
    live.delete(id)
  }
}

/**
 * Encerra o transcriber subido por este app (e fecha WS ao vivo). Não toca em
 * um server.py que já estava rodando antes. Chamar no before-quit do main.
 */
export function stopTranscriber(): void {
  closeAllLive()
  killChild()
}

async function stop(): Promise<TranscriberStatus> {
  if (!child || child.exitCode !== null) {
    const s = await status()
    if (s.running) throw new Error('o transcriber na porta 7100 não foi iniciado por este app — não vou matá-lo')
    return s
  }
  const proc = child
  closeAllLive()
  await new Promise<void>((resolve) => {
    if (proc.exitCode !== null) return resolve()
    proc.once('exit', () => resolve())
    killChild()
  })
  lastError = undefined
  return emitStatus()
}

// ---------------------------------------------------------- transcrição ---

async function ensureRunning(): Promise<void> {
  const p = await probe()
  if (p.kind === 'transcriber') return
  await start()
}

function parseResult(r: HttpResult): TranscribeResult {
  if (r.status !== 200) throw httpError(r)
  const j = JSON.parse(r.body) as Partial<TranscribeResult>
  return { text: j.text ?? '', language: j.language ?? null, srt: j.srt ?? '' }
}

type UploadReq = { path: string; language?: string } | { bytes: ArrayBuffer | Uint8Array; name: string; language?: string }

function safeName(n: string): string {
  return n.replace(/["\r\n]/g, '_') || 'audio'
}

async function upload(req: UploadReq): Promise<TranscribeResult> {
  await ensureRunning()
  const language = req.language || 'auto'
  const boundary = `----hc${randomBytes(12).toString('hex')}`
  let name: string
  let size: number
  let fileBuf: Buffer | null = null
  let filePath: string | null = null
  if ('path' in req) {
    if (!existsSync(req.path)) throw new Error(`arquivo não encontrado: ${req.path}`)
    filePath = req.path
    name = basename(req.path)
    size = statSync(req.path).size
  } else {
    fileBuf = Buffer.from(req.bytes instanceof Uint8Array ? req.bytes : new Uint8Array(req.bytes))
    name = req.name
    size = fileBuf.length
  }
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName(name)}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const r = await http('POST', '/api/transcribe/file', {
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': head.length + size + tail.length },
    write: (hr) => {
      hr.write(head)
      if (fileBuf) {
        hr.write(fileBuf)
        hr.end(tail)
      } else if (filePath) {
        const rs = createReadStream(filePath)
        rs.on('error', (e) => hr.destroy(e))
        rs.on('end', () => hr.end(tail))
        rs.pipe(hr, { end: false })
      }
    },
  })
  return parseResult(r)
}

async function youtube(req: { url: string; language?: string }): Promise<TranscribeResult> {
  const url = (req?.url ?? '').trim()
  if (!/^https?:\/\//i.test(url)) throw new Error('URL inválida (use http/https)')
  await ensureRunning()
  const body = Buffer.from(JSON.stringify({ url, language: req.language || 'auto' }))
  const r = await http('POST', '/api/transcribe/youtube', {
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    write: (hr) => hr.end(body),
  })
  return parseResult(r)
}

async function devices(): Promise<{ devices: string[]; blackhole: boolean }> {
  await ensureRunning()
  const r = await http('GET', '/api/audio-devices', { timeoutMs: 20_000 })
  if (r.status === 404) throw new Error('este server.py não tem /api/audio-devices (versão antiga em execução? reinicie o transcriber)')
  if (r.status !== 200) throw httpError(r)
  return JSON.parse(r.body) as { devices: string[]; blackhole: boolean }
}

// ------------------------------------------------------------- tempo real ---

type LiveSource = 'mic' | 'system' | 'both'

async function liveOpen(req: { id: string; language?: string; source?: LiveSource }): Promise<{ ok: boolean; error?: string }> {
  const id = String(req?.id ?? '')
  if (!id) return { ok: false, error: 'id ausente' }
  const source: LiveSource = req.source === 'system' || req.source === 'both' ? req.source : 'mic'
  try {
    await ensureRunning()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  live.get(id)?.close()
  const qs = new URLSearchParams({ language: req.language || 'auto', source })
  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws/live?${qs}`)
  ws.binaryType = 'arraybuffer'
  live.set(id, ws)
  const send = (payload: unknown) => broadcast('transcriber:live', payload)

  return new Promise((resolve) => {
    let settled = false
    // o server encerra o socket sem handshake logo após {type:'done'} — o
    // 'error' que o Node emite nessa hora é ruído, não falha.
    let done = false
    ws.onopen = () => {
      settled = true
      send({ id, kind: 'state', state: 'open' })
      resolve({ ok: true })
    }
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return
      try {
        const msg = JSON.parse(ev.data) as { type?: string }
        if (msg.type === 'done') done = true
        send({ id, kind: 'msg', msg })
      } catch {
        send({ id, kind: 'msg', msg: { type: 'error', text: `mensagem inválida do server: ${ev.data.slice(0, 120)}` } })
      }
    }
    ws.onerror = () => {
      if (!settled) {
        settled = true
        resolve({ ok: false, error: 'falha ao abrir o WebSocket /ws/live' })
      }
      if (!done) send({ id, kind: 'state', state: 'error', message: 'erro no WebSocket do transcriber' })
    }
    ws.onclose = (ev) => {
      if (live.get(id) === ws) live.delete(id)
      if (!settled) {
        settled = true
        resolve({ ok: false, error: `WebSocket fechou (code ${ev.code})` })
      }
      send({ id, kind: 'state', state: 'closed', message: ev.reason || undefined })
    }
  })
}

function liveSend(id: string, data: ArrayBuffer | Uint8Array | string): void {
  const ws = live.get(id)
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (typeof data === 'string') ws.send(data)
  else ws.send(new Uint8Array(data)) // cópia → Uint8Array<ArrayBuffer> (IPC pode entregar Buffer/ArrayBuffer)
}

function liveClose(id: string): void {
  const ws = live.get(id)
  if (!ws) return
  live.delete(id)
  try {
    ws.close()
  } catch {
    /* já fechado */
  }
}

// --------------------------------------------------------------- arquivos ---

async function pickFile(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    title: 'Arquivo de áudio/vídeo para transcrever',
    properties: ['openFile' as const],
    filters: [
      { name: 'Áudio/Vídeo', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm', 'mp4', 'mov', 'mkv', 'aiff', 'aif'] },
      { name: 'Todos', extensions: ['*'] },
    ],
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

async function save(req: { name: string; content: string }): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts = { defaultPath: join(homedir(), 'Downloads', basename(req.name || 'transcricao.txt')) }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  if (r.canceled || !r.filePath) return null
  await writeFile(r.filePath, req.content ?? '', 'utf8')
  return r.filePath
}

// ---------------------------------------------------------------- registro ---

export function register(): void {
  handle('transcriber:status', () => status())
  handle('transcriber:start', () => start())
  handle('transcriber:stop', () => stop())
  handle('transcriber:logs', () => logs.slice())
  handle('transcriber:devices', () => devices())
  handle('transcriber:pickFile', () => pickFile())
  handle('transcriber:upload', (req: UploadReq) => upload(req))
  handle('transcriber:youtube', (req: { url: string; language?: string }) => youtube(req))
  handle('transcriber:save', (req: { name: string; content: string }) => save(req))
  handle('transcriber:liveOpen', (req: { id: string; language?: string; source?: LiveSource }) => liveOpen(req))
  handle('transcriber:liveSend', (id: string, data: ArrayBuffer | Uint8Array | string) => liveSend(id, data))
  handle('transcriber:liveClose', (id: string) => liveClose(id))
}
