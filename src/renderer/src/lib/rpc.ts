// Cliente JSON-RPC 2.0 mínimo sobre WebSocket — mesmo envelope do
// json-rpc-channel.ts do @hermes/shared: { jsonrpc, id, method, params }.
// Requests vindos do servidor recebem -32601 (method not found), como o
// cliente oficial faz para handlers desconhecidos.

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const RPC_TIMEOUT_MS = 20_000

export class HermesRpc {
  private ws: WebSocket | null = null
  private seq = 0
  private pending = new Map<string, Pending>()

  onState: (state: ConnState) => void = () => {}
  onEvent: (method: string, params: unknown) => void = () => {}

  connect(wsUrl: string): void {
    this.onState('connecting')
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => this.onState('open')
    ws.onclose = () => {
      this.onState('closed')
      this.failAll(new Error('websocket fechado'))
    }
    ws.onerror = () => this.onState('error')
    ws.onmessage = (ev) => this.handle(ev.data)
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`rpc sem conexão aberta (${method})`))
    }
    const id = `c${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout de ${RPC_TIMEOUT_MS / 1000}s em ${method}`))
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  close(): void {
    this.ws?.close()
    this.ws = null
  }

  private handle(raw: unknown): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    const { id, method, params, result, error } = frame

    // Resposta a uma chamada nossa
    if (typeof id === 'string' && method === undefined) {
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      if (error) {
        const msg =
          typeof error === 'object' && error && 'message' in error
            ? String((error as { message: unknown }).message)
            : JSON.stringify(error)
        p.reject(new Error(msg))
      } else {
        p.resolve(result)
      }
      return
    }

    // Request vindo do servidor — não temos handlers; -32601 padrão
    if (typeof id === 'string' && typeof method === 'string' && method !== 'event') {
      this.ws?.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `no handler for server request: ${method}` },
        }),
      )
      return
    }

    // Evento/notificação
    if (typeof method === 'string') this.onEvent(method, params)
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
