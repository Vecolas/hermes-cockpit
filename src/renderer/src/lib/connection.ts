import type { BackendInfo } from '../env'

export type Connection =
  | { mode: 'electron'; info: BackendInfo }
  | { mode: 'web'; info: BackendInfo }

const STORAGE_KEY = 'hermes-cockpit.backend'

// Electron: o main process spawna `hermes serve` e entrega a info MASCARADA
// (token '' e wsUrl sem ?token=) — WS e REST passam pelo proxy IPC do main.
// Navegador (dev:web): sem bridge — usa conexão manual salva em localStorage.
export async function connectBackend(): Promise<Connection> {
  if (window.hermes) {
    return { mode: 'electron', info: await window.hermes.backend() }
  }
  const saved = readManual()
  if (saved) return { mode: 'web', info: saved }
  throw new Error('no-manual-connection')
}

export function readManual(): BackendInfo | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { baseUrl?: string; token?: string }
    if (!parsed.baseUrl || !parsed.token) return null
    const base = parsed.baseUrl.replace(/\/+$/, '')
    return {
      baseUrl: base,
      wsUrl: `${base.replace(/^http/, 'ws')}/api/ws?token=${encodeURIComponent(parsed.token)}`,
      token: parsed.token,
    }
  } catch {
    return null
  }
}

export function saveManual(baseUrl: string, token: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl, token }))
}

// REST do plugin cockpit. No Electron passa pelo proxy do main (sem CORS);
// no navegador manda o header x-hermes-session-token (o serve rejeita REST só
// com ?token=). Limitação: o serve responde 401 ao preflight CORS (auth roda
// antes do CORS), então cross-origin direto só funciona atrás de um proxy
// same-origin no dev server — modo degradado.
export async function cockpitApi<T>(conn: Connection, path: string): Promise<T> {
  if (conn.mode === 'electron' && window.hermes) {
    return (await window.hermes.api(path)) as T
  }
  const res = await fetch(`${conn.info.baseUrl}${path}`, {
    headers: { 'x-hermes-session-token': conn.info.token },
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return (await res.json()) as T
}
