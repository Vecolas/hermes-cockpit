import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { cockpitApi, type Connection } from '../../lib/connection'

// Fonte de dados compartilhada para os painéis do plugin cockpit.
// Um poller por rota, não importa quantos painéis a assinem (topbar, rail,
// strip e dock podem ler /quota ao mesmo tempo sem multiplicar requisições).
// Falha vira `error` no estado — nunca exceção para a UI.

export interface SourceState<T> {
  data: T | null
  error: string | null
  loading: boolean
  updatedAt: number | null
}

interface Entry {
  state: SourceState<unknown>
  listeners: Set<() => void>
  intervals: Map<symbol, number>
  timer: ReturnType<typeof setInterval> | null
  period: number
  inflight: boolean
}

const EMPTY: SourceState<unknown> = { data: null, error: null, loading: true, updatedAt: null }

class SourceStore {
  private entries = new Map<string, Entry>()
  constructor(private conn: Connection) {}

  private entry(path: string): Entry {
    let e = this.entries.get(path)
    if (!e) {
      e = { state: EMPTY, listeners: new Set(), intervals: new Map(), timer: null, period: 0, inflight: false }
      this.entries.set(path, e)
    }
    return e
  }

  get(path: string): SourceState<unknown> {
    return this.entries.get(path)?.state ?? EMPTY
  }

  subscribe(path: string, refreshMs: number, fn: () => void): () => void {
    const e = this.entry(path)
    const key = Symbol(path)
    e.listeners.add(fn)
    e.intervals.set(key, refreshMs)
    this.reschedule(path, e)
    if (e.state.updatedAt === null && !e.inflight) void this.fetch(path, e)
    return () => {
      e.listeners.delete(fn)
      e.intervals.delete(key)
      this.reschedule(path, e)
    }
  }

  refresh(path: string): void {
    const e = this.entries.get(path)
    if (e) void this.fetch(path, e)
  }

  dispose(): void {
    for (const e of this.entries.values()) if (e.timer) clearInterval(e.timer)
    this.entries.clear()
  }

  private reschedule(path: string, e: Entry): void {
    const period = e.intervals.size ? Math.max(5_000, Math.min(...e.intervals.values())) : 0
    if (period === e.period) return
    if (e.timer) clearInterval(e.timer)
    e.timer = period ? setInterval(() => void this.fetch(path, e), period) : null
    e.period = period
  }

  private async fetch(path: string, e: Entry): Promise<void> {
    if (e.inflight) return
    e.inflight = true
    try {
      const data = await cockpitApi<unknown>(this.conn, path)
      // O plugin devolve {"error": "..."} em vez de lançar (contrato dele).
      const pluginErr =
        data && typeof data === 'object' && !Array.isArray(data) && typeof (data as { error?: unknown }).error === 'string'
          ? String((data as { error: string }).error)
          : null
      e.state = pluginErr
        ? { data: e.state.data, error: pluginErr, loading: false, updatedAt: Date.now() }
        : { data, error: null, loading: false, updatedAt: Date.now() }
    } catch (err) {
      e.state = {
        data: e.state.data,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 160),
        loading: false,
        updatedAt: Date.now(),
      }
    } finally {
      e.inflight = false
      for (const l of e.listeners) l()
    }
  }
}

const Ctx = createContext<SourceStore | null>(null)

export function SourceProvider({ conn, children }: { conn: Connection | null; children: ReactNode }) {
  const [store, setStore] = useState<SourceStore | null>(null)
  useEffect(() => {
    if (!conn) return
    const s = new SourceStore(conn)
    setStore(s)
    return () => {
      s.dispose()
      setStore(null)
    }
  }, [conn])
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

/** Lê uma rota do plugin cockpit com polling compartilhado. `path` null = desligado. */
export function usePluginSource<T>(path: string | null, refreshMs = 60_000): SourceState<T> & { refresh: () => void } {
  const store = useContext(Ctx)
  const [, bump] = useState(0)
  useEffect(() => {
    if (!store || !path) return
    return store.subscribe(path, refreshMs, () => bump((n) => n + 1))
  }, [store, path, refreshMs])
  const state = (store && path ? store.get(path) : { ...EMPTY, loading: !!path }) as SourceState<T>
  return { ...state, refresh: () => store && path && store.refresh(path) }
}
