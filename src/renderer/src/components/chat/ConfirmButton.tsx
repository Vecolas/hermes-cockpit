import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'

interface Props {
  /** rótulo no estado normal */
  children: ReactNode
  /** rótulo armado (2º clique executa) */
  confirmLabel?: ReactNode
  onConfirm: () => void | Promise<void>
  disabled?: boolean
  title?: string
  className?: string
  armedClassName?: string
  /** ms até desarmar sozinho */
  timeoutMs?: number
}

// Confirmação inline de 2 cliques para ações destrutivas (nunca window.confirm —
// dialogs nativos bloqueiam o renderer). 1º clique arma (vermelho), 2º executa;
// desarma sozinho após `timeoutMs` ou ao perder o foco.
export function ConfirmButton({
  children,
  confirmLabel = 'confirmar?',
  onConfirm,
  disabled,
  title,
  className = 'rounded border border-edge px-2 py-0.5 text-[11px] text-dim hover:border-alert/60 hover:text-alert',
  armedClassName = 'rounded border border-alert bg-alert/15 px-2 py-0.5 text-[11px] font-semibold text-alert',
  timeoutMs = 4000,
}: Props) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const click = async (e: MouseEvent) => {
    e.stopPropagation()
    if (busy || disabled) return
    if (!armed) {
      setArmed(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setArmed(false), timeoutMs)
      return
    }
    if (timer.current) clearTimeout(timer.current)
    setArmed(false)
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      type="button"
      title={armed ? 'clique de novo para confirmar' : title}
      disabled={disabled || busy}
      onClick={(e) => void click(e)}
      onBlur={() => setArmed(false)}
      className={`${armed ? armedClassName : className} transition-colors disabled:opacity-40`}
    >
      {busy ? '…' : armed ? confirmLabel : children}
    </button>
  )
}
