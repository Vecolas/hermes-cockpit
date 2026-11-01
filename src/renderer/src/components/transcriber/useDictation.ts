import { useCallback, useEffect, useRef, useState } from 'react'
import { LiveSession, errMsg, transcriber } from '../../lib/transcriber'

// CONTRATO (fixo) do ditado no composer, implementado sobre o ~/dev/transcriber
// (WS de tempo real, source=mic). O serviço sobe sob demanda no start().
//
// Semântica de onText com este backend: o server.py só emite texto CONFIRMADO
// em janelas de ~4s (não há parciais). Cada chamada é onText(trecho, true) com
// um trecho NOVO — o consumidor deve ANEXAR (com espaço) ao que já tem.
// final=false nunca é emitido hoje; se vier no futuro, substitui o parcial anterior.
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
  const [available, setAvailable] = useState(false)
  const [state, setState] = useState<DictationState>('idle')
  const [error, setError] = useState<string | undefined>()
  const session = useRef<LiveSession | null>(null)

  useEffect(() => {
    if (!transcriber.available()) return
    let alive = true
    transcriber
      .status()
      .then((s) => alive && setAvailable(s.installed && s.venv))
      .catch(() => alive && setAvailable(false))
    const off = transcriber.onStatus((s) => setAvailable(s.installed && s.venv))
    return () => {
      alive = false
      off()
      session.current?.abort()
      session.current = null
    }
  }, [])

  const start = useCallback((onText: (text: string, final: boolean) => void) => {
    if (session.current) return
    setError(undefined)
    setState('starting')
    const s = new LiveSession('mic', 'auto', {
      onText: (t) => onText(t, true),
      onError: (m) => {
        setError(m)
        setState('error')
      },
      onEnd: () => {
        if (session.current === s) session.current = null
        setState((prev) => (prev === 'error' ? 'error' : 'idle'))
      },
    })
    session.current = s
    s.start()
      .then(() => {
        if (session.current === s) setState('listening')
      })
      .catch((err: unknown) => {
        if (session.current === s) session.current = null
        setError(errMsg(err))
        setState('error')
      })
  }, [])

  const stop = useCallback(() => {
    // stop() deixa o server transcrever o resto; o onText ainda pode chegar
    // até o 'done'. O estado volta a idle no onEnd.
    session.current?.stop()
  }, [])

  return { available, state, error, start, stop }
}
