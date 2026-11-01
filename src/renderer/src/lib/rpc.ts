// Cliente JSON-RPC 2.0 sobre WebSocket — mesmo envelope do
// json-rpc-channel.ts do @hermes/shared: { jsonrpc, id, method, params }.
//
// Transport:
//   - Electron (bridge window.hermes.ws presente): IPC pelo main process
//     (src/main/wsproxy.ts). O main abre o WS e anexa o token; o `wsUrl`
//     passado a connect() serve só para extrair o caminho (/api/ws).
//   - Navegador (dev:web): WebSocket nativo direto no wsUrl.
//
// Reconexão automática com backoff exponencial (0.5s → 8s) enquanto close()
// não for chamado. Requests servidor→cliente (id + method) vão para o handler
// registrado em setRequestHandler(); sem handler → -32601, se lançar → -32000.

import type { WsProxyData, WsProxyStateInfo } from '../env'

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

export type RpcListener = (method: string, params: unknown) => void
export type RpcRequestHandler = (method: string, params: unknown) => Promise<unknown>

export class RpcError extends Error {
  readonly code?: number
  readonly data?: unknown
  constructor(message: string, code?: number, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface Transport {
  send(data: string): void
  close(): void
}

interface TransportHooks {
  onOpen(): void
  onMessage(data: string): void
  onError(message: string): void
  onClose(): void
}

const RPC_TIMEOUT_MS = 20_000
// Métodos que podem passar de 20s com backend frio (resume carrega transcript,
// model.options consulta provedores). Mantém a assinatura de call() intacta.
const SLOW_METHOD_TIMEOUT_MS: Record<string, number> = {
  'model.options': 60_000,
  'session.resume': 60_000,
  'session.create': 45_000,
}
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 8_000
const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_SERVER_ERROR = -32000

// ── Transport IPC (Electron) ────────────────────────────────────────────────

let ipcSeq = 0

function ipcTransport(wsUrl: string, hooks: TransportHooks): Transport | null {
  const bridge = typeof window !== 'undefined' ? window.hermes?.ws : undefined
  if (!bridge) return null
  const id = `rpc-${Date.now().toString(36)}-${++ipcSeq}`
  let closed = false

  const offFrame = bridge.onFrame((fid: string, data: WsProxyData) => {
    if (fid !== id || closed) return
    hooks.onMessage(typeof data === 'string' ? data : new TextDecoder().decode(data))
  })
  const offState = bridge.onState((sid: string, info: WsProxyStateInfo) => {
    if (sid !== id || closed) return
    if (info.state === 'open') hooks.onOpen()
    else if (info.state === 'error') hooks.onError(info.message ?? 'erro no websocket')
    else if (info.state === 'closed') {
      teardown()
      hooks.onClose()
    }
  })

  function teardown(): void {
    if (closed) return
    closed = true
    offFrame()
    offState()
  }

  void bridge.open(id, pathOf(wsUrl)).then(
    (res) => {
      // Falha antes de qualquer evento (ex.: id inválido): garante o close.
      if (!res.ok && !closed) {
        hooks.onError(res.error ?? 'falha ao abrir websocket')
        teardown()
        hooks.onClose()
      }
    },
    (err: unknown) => {
      if (closed) return
      hooks.onError(err instanceof Error ? err.message : String(err))
      teardown()
      hooks.onClose()
    },
  )

  return {
    send: (data) => bridge.send(id, data),
    close: () => {
      if (closed) return
      teardown()
      bridge.close(id, 1000, 'client close')
    },
  }
}

// Caminho + query sem token (o main anexa o seu).
function pathOf(wsUrl: string): string {
  try {
    const u = new URL(wsUrl)
    u.searchParams.delete('token')
    return `${u.pathname}${u.search}`
  } catch {
    return wsUrl.startsWith('/') ? wsUrl : '/api/ws'
  }
}

// ── Transport WebSocket nativo (dev:web) ────────────────────────────────────

function nativeTransport(wsUrl: string, hooks: TransportHooks): Transport {
  let ws: WebSocket | null = null
  let closed = false
  try {
    ws = new WebSocket(wsUrl)
  } catch (err) {
    // URL inválida: reporta de forma assíncrona para manter a ordem dos estados.
    queueMicrotask(() => {
      hooks.onError(err instanceof Error ? err.message : String(err))
      hooks.onClose()
    })
    return { send: () => {}, close: () => {} }
  }
  ws.onopen = () => !closed && hooks.onOpen()
  ws.onmessage = (ev) => !closed && hooks.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data))
  ws.onerror = () => !closed && hooks.onError('erro no websocket')
  ws.onclose = () => {
    if (closed) return
    closed = true
    hooks.onClose()
  }
  return {
    send: (data) => ws?.send(data),
    close: () => {
      if (closed) return
      closed = true
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
    },
  }
}

// ── HermesRpc ───────────────────────────────────────────────────────────────

export class HermesRpc {
  private transport: Transport | null = null
  private open = false
  private url: string | null = null
  private stopped = true
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sawError = false
  private seq = 0
  private pending = new Map<string, Pending>()
  private listeners = new Set<RpcListener>()
  private requestHandler: RpcRequestHandler | null = null

  onState: (state: ConnState) => void = () => {}
  /** Legado: listener único de eventos. Prefira subscribe(). */
  onEvent: (method: string, params: unknown) => void = () => {}

  connect(wsUrl: string): void {
    this.teardownTransport()
    this.clearReconnect()
    this.url = wsUrl
    this.stopped = false
    this.attempt = 0
    this.openTransport()
  }

  isOpen(): boolean {
    return this.open && this.transport !== null
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const transport = this.transport
    if (!transport || !this.open) {
      return Promise.reject(new RpcError(`rpc sem conexão aberta (${method})`))
    }
    const id = `c${++this.seq}`
    const timeoutMs = SLOW_METHOD_TIMEOUT_MS[method] ?? RPC_TIMEOUT_MS
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RpcError(`timeout de ${timeoutMs / 1000}s em ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      try {
        transport.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new RpcError(err instanceof Error ? err.message : String(err)))
      }
    })
  }

  subscribe(fn: RpcListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  setRequestHandler(fn: RpcRequestHandler | null): void {
    this.requestHandler = fn
  }

  close(): void {
    this.stopped = true
    this.clearReconnect()
    const had = this.transport !== null
    this.teardownTransport()
    this.failAll(new RpcError('rpc fechado pelo cliente'))
    if (had || this.url) this.onState('closed')
  }

  // ── internos ──

  private openTransport(): void {
    const url = this.url
    if (!url || this.stopped) return
    this.open = false
    this.sawError = false
    this.onState('connecting')

    let self: Transport | null = null
    const isCurrent = () => self !== null && this.transport === self
    const hooks: TransportHooks = {
      onOpen: () => {
        if (!isCurrent()) return
        this.open = true
        this.attempt = 0
        this.onState('open')
      },
      onMessage: (data) => {
        if (isCurrent()) this.handle(data)
      },
      onError: () => {
        if (isCurrent()) this.sawError = true
      },
      onClose: () => {
        if (!isCurrent()) return
        this.transport = null
        this.open = false
        this.failAll(new RpcError('websocket fechado'))
        if (this.stopped) return
        this.onState(this.sawError ? 'error' : 'closed')
        this.scheduleReconnect()
      },
    }
    // `self` precisa existir antes dos hooks dispararem: ambos os transports
    // só disparam de forma assíncrona.
    self = ipcTransport(url, hooks) ?? nativeTransport(url, hooks)
    this.transport = self
  }

  private scheduleReconnect(): void {
    this.clearReconnect()
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 10)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openTransport()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private teardownTransport(): void {
    const t = this.transport
    this.transport = null
    this.open = false
    t?.close()
  }

  private send(frame: Record<string, unknown>): void {
    try {
      this.transport?.send(JSON.stringify({ jsonrpc: '2.0', ...frame }))
    } catch {
      /* transport caiu — a reconexão cuida */
    }
  }

  private handle(raw: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return
    const { id, method, params, result, error } = frame
    const hasId = id !== undefined && id !== null

    // Request vindo do servidor (id + method; 'event' é sempre notificação).
    if (hasId && typeof method === 'string' && method !== 'event') {
      this.serveRequest(id as string | number, method, params)
      return
    }

    // Resposta a uma chamada nossa
    if (hasId && method === undefined) {
      const p = this.pending.get(String(id))
      if (!p) return
      this.pending.delete(String(id))
      clearTimeout(p.timer)
      if (error !== undefined && error !== null) {
        const e = (typeof error === 'object' ? error : {}) as { message?: unknown; code?: unknown; data?: unknown }
        const msg = typeof e.message === 'string' && e.message ? e.message : JSON.stringify(error)
        p.reject(new RpcError(msg, typeof e.code === 'number' ? e.code : undefined, e.data))
      } else {
        // Contrato de reconexão do gateway: session.resume/activate/events.since
        // devolvem `open_requests` (requests servidor→cliente ainda pendentes).
        this.deliverOpenRequests(result)
        p.resolve(result)
      }
      return
    }

    // Evento/notificação
    if (typeof method === 'string') this.emit(method, params)
  }

  private deliverOpenRequests(result: unknown): void {
    const open = (result as { open_requests?: unknown } | null)?.open_requests
    if (!Array.isArray(open)) return
    for (const entry of open as Array<{ id?: unknown; method?: unknown; params?: unknown }>) {
      if ((typeof entry?.id === 'string' || typeof entry?.id === 'number') && typeof entry.method === 'string') {
        this.serveRequest(entry.id, entry.method, entry.params)
      }
    }
  }

  private serveRequest(id: string | number, method: string, params: unknown): void {
    const handler = this.requestHandler
    if (!handler) {
      this.send({ id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `no handler for server request: ${method}` } })
      return
    }
    Promise.resolve()
      .then(() => handler(method, params))
      .then(
        (value) => this.send({ id, result: value === undefined ? null : value }),
        (err: unknown) =>
          this.send({
            id,
            error: { code: JSON_RPC_SERVER_ERROR, message: err instanceof Error ? err.message : String(err) },
          }),
      )
  }

  private emit(method: string, params: unknown): void {
    try {
      this.onEvent(method, params)
    } catch (err) {
      console.error('[rpc] onEvent lançou', err)
    }
    for (const fn of [...this.listeners]) {
      try {
        fn(method, params)
      } catch (err) {
        console.error('[rpc] listener lançou', err)
      }
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
