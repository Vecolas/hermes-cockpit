import type { ApiInit } from '../env'

// Acesso tipado ao IPC de domínio do main (src/main/ipc/*). Fora do Electron
// (dev:web) não há main: as funções rejeitam com erro claro e a UI mostra
// estado "indisponível no navegador" — nunca derruba.

export const hasMain = (): boolean => typeof window !== 'undefined' && Boolean(window.hermes?.invoke)

export function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.hermes?.invoke) return Promise.reject(new Error('indisponível fora do app (sem main process)'))
  return window.hermes.invoke(channel, ...args) as Promise<T>
}

/** Assina evento main→renderer; no navegador vira no-op. */
export function onMain<T = unknown>(channel: string, fn: (payload: T) => void): () => void {
  if (!window.hermes?.on) return () => {}
  return window.hermes.on(channel, fn as (p: unknown) => void)
}

/** REST do serve com método/body (Electron: proxy no main). */
export function api<T = unknown>(path: string, init?: ApiInit): Promise<T> {
  if (!window.hermes?.api) return Promise.reject(new Error('REST indisponível fora do app'))
  return window.hermes.api(path, init) as Promise<T>
}
