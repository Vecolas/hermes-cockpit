// Proxy WebSocket pelo main process (P0-1).
//
// Por quê: o renderer empacotado roda em file:// e o token de sessão não deve
// morar no renderer. O main abre o WebSocket com o WebSocket global do Node
// (Electron 40 → Node 24; sem dependência nova). O upgrade sai SEM header
// Origin, o que o guard do serve aceita (hermes_cli/web_server_chat.py::
// _ws_host_origin_reason: Origin ausente → permitido; Host 127.0.0.1 confere).
//
// Protocolo IPC (renderer → main):
//   invoke 'hermes:ws:open'  (id, path?)          → {ok:true} no 'open' | {ok:false,error}
//   send   'hermes:ws:send'  (id, data)           → string | ArrayBuffer | Uint8Array
//   send   'hermes:ws:close' (id, code?, reason?)
// Eventos (main → renderer, webContents.send):
//   'hermes:ws:frame' (id, data: string | ArrayBuffer)
//   'hermes:ws:state' (id, { state, code?, reason?, message? })
//     state ∈ 'connecting' | 'open' | 'error' | 'closed'; 'closed' é sempre o
//     último evento de um id (exatamente uma vez).
//
// Conexões são identificadas por (webContents, id) — o renderer escolhe o id
// e pode abrir várias (rpc, pty...). Todas fecham quando o webContents é
// destruído ou navega (reload).

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { ensureBackend } from './backend'

export type WsProxyState = 'connecting' | 'open' | 'error' | 'closed'

export interface WsProxyStateInfo {
  state: WsProxyState
  code?: number
  reason?: string
  message?: string
}

interface Entry {
  id: string
  wc: WebContents
  ws: WebSocket | null
  done: boolean
}

const ID_RE = /^[A-Za-z0-9._:-]{1,96}$/
// Só rotas WS do próprio serve. O token é anexado aqui; um token vindo do
// renderer é descartado.
const PATH_RE = /^\/api\/[A-Za-z0-9/_-]+$/
const DEFAULT_PATH = '/api/ws'

const conns = new Map<string, Entry>()
const trackedContents = new Set<number>()

const keyOf = (wc: WebContents, id: string) => `${wc.id}:${id}`

function emitState(entry: Entry, info: WsProxyStateInfo): void {
  if (entry.wc.isDestroyed()) return
  entry.wc.send('hermes:ws:state', entry.id, info)
}

function finish(entry: Entry, info: Omit<WsProxyStateInfo, 'state'> = {}): void {
  if (entry.done) return
  entry.done = true
  const key = keyOf(entry.wc, entry.id)
  if (conns.get(key) === entry) conns.delete(key)
  emitState(entry, { state: 'closed', ...info })
}

function closeEntry(entry: Entry, code = 1000, reason = ''): void {
  const ws = entry.ws
  entry.ws = null
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    // Cliente WHATWG só pode mandar 1000 ou 3000–4999; o código "real"
    // (ex.: 1001) vai só no estado para o renderer.
    const wire = code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000
    try {
      ws.close(wire, reason.slice(0, 120))
    } catch {
      /* close com código inválido etc. — encerra sem código */
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }
  finish(entry, { code, reason })
}

function closeAllFor(wcId: number): void {
  for (const entry of [...conns.values()]) if (entry.wc.id === wcId) closeEntry(entry, 1001, 'renderer gone')
}

export function closeAllWs(): void {
  for (const entry of [...conns.values()]) closeEntry(entry, 1001, 'app quitting')
}

function track(wc: WebContents): void {
  if (trackedContents.has(wc.id)) return
  trackedContents.add(wc.id)
  const id = wc.id
  wc.once('destroyed', () => {
    trackedContents.delete(id)
    closeAllFor(id)
  })
  wc.on('render-process-gone', () => closeAllFor(id))
  // Reload / navegação do frame principal: a página nova não conhece os ids
  // antigos — fecha para não vazar sockets.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) closeAllFor(id)
  })
}

function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return DEFAULT_PATH
  let pathname = raw
  let search = ''
  // Aceita URL completa (ex.: wsUrl legado) ou só o caminho.
  if (/^[a-z]+:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      pathname = u.pathname
      search = u.search
    } catch {
      return DEFAULT_PATH
    }
  } else {
    const q = raw.indexOf('?')
    if (q >= 0) {
      pathname = raw.slice(0, q)
      search = raw.slice(q)
    }
  }
  if (!PATH_RE.test(pathname)) throw new Error(`caminho WS inválido: ${pathname.slice(0, 80)}`)
  const params = new URLSearchParams(search)
  params.delete('token')
  const qs = params.toString()
  return qs ? `${pathname}?${qs}` : pathname
}

export interface WsOpenResult {
  ok: boolean
  error?: string
}

// Resultado em vez de throw: rejeição de ipcMain.handle loga stack no console
// do main a cada tentativa de reconexão.
async function open(event: IpcMainInvokeEvent, id: unknown, rawPath: unknown): Promise<WsOpenResult> {
  try {
    await openOrThrow(event, id, rawPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function openOrThrow(event: IpcMainInvokeEvent, id: unknown, rawPath: unknown): Promise<void> {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('id de conexão WS inválido')
  const wc = event.sender
  track(wc)
  const path = normalizePath(rawPath)
  const key = keyOf(wc, id)

  const previous = conns.get(key)
  if (previous) closeEntry(previous, 1000, 'replaced')

  const entry: Entry = { id, wc, ws: null, done: false }
  conns.set(key, entry)
  emitState(entry, { state: 'connecting' })

  let info
  try {
    info = await ensureBackend()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    emitState(entry, { state: 'error', message })
    finish(entry, { code: 1011, reason: 'backend indisponível' })
    throw new Error(message)
  }
  // Fechado (ou substituído) enquanto o backend subia.
  if (entry.done) throw new Error('conexão WS fechada antes de abrir')

  const url = new URL(path, info.baseUrl.replace(/^http/, 'ws'))
  url.searchParams.set('token', info.token)

  return new Promise<void>((resolve, reject) => {
    let opened = false
    let ws: WebSocket
    try {
      ws = new WebSocket(url.toString())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      emitState(entry, { state: 'error', message })
      finish(entry, { code: 1006 })
      reject(new Error(message))
      return
    }
    ws.binaryType = 'arraybuffer'
    entry.ws = ws

    ws.addEventListener('open', () => {
      if (entry.done) {
        ws.close(1000, 'closed before open')
        return
      }
      opened = true
      emitState(entry, { state: 'open' })
      resolve()
    })
    ws.addEventListener('message', (ev) => {
      if (entry.done || entry.wc.isDestroyed()) return
      const data: unknown = ev.data
      if (typeof data === 'string' || data instanceof ArrayBuffer) {
        entry.wc.send('hermes:ws:frame', id, data)
      }
    })
    ws.addEventListener('error', (ev) => {
      if (entry.done) return
      const message = (ev as unknown as { message?: string }).message || 'erro no websocket'
      emitState(entry, { state: 'error', message })
    })
    ws.addEventListener('close', (ev) => {
      if (entry.ws === ws) entry.ws = null
      finish(entry, { code: ev.code, reason: ev.reason })
      if (!opened) reject(new Error(`websocket fechou antes de abrir (code ${ev.code})`))
    })
  })
}

function send(event: IpcMainEvent, id: unknown, data: unknown): void {
  if (typeof id !== 'string') return
  const entry = conns.get(keyOf(event.sender, id))
  const ws = entry?.ws
  if (!entry || !ws || ws.readyState !== WebSocket.OPEN) {
    if (entry) emitState(entry, { state: 'error', message: 'envio com websocket não aberto' })
    return
  }
  try {
    if (typeof data === 'string' || data instanceof ArrayBuffer) ws.send(data)
    else if (data instanceof Uint8Array) ws.send(new Uint8Array(data))
  } catch (err) {
    emitState(entry, { state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

function close(event: IpcMainEvent, id: unknown, code: unknown, reason: unknown): void {
  if (typeof id !== 'string') return
  const entry = conns.get(keyOf(event.sender, id))
  if (!entry) return
  closeEntry(entry, typeof code === 'number' ? code : 1000, typeof reason === 'string' ? reason.slice(0, 120) : '')
}

export function registerWsProxy(): void {
  ipcMain.handle('hermes:ws:open', open)
  ipcMain.on('hermes:ws:send', send)
  ipcMain.on('hermes:ws:close', close)
}
