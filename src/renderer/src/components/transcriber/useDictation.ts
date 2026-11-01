// STUB do scaffold — CONTRATO (fixo) do ditado no composer, implementado pelo
// agente do transcriber sobre o ~/dev/transcriber (WS de tempo real).
export type DictationState = 'idle' | 'starting' | 'listening' | 'error'

export interface Dictation {
  /** transcriber instalado/alcançável (pode subir sob demanda no start) */
  available: boolean
  state: DictationState
  error?: string
  /** onText: parcial (final=false) substitui o parcial anterior; final=true confirma */
  start(onText: (text: string, final: boolean) => void): void
  stop(): void
}

export function useDictation(): Dictation {
  return { available: false, state: 'idle', start: () => {}, stop: () => {} }
}
