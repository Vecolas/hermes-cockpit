import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, type ButtonSize } from './Button'
import { cx } from './cx'

/**
 * Confirmação inline de 2 cliques para ações destrutivas (apagar sessão, matar
 * processo, remover container/modelo/worktree). 1º clique arma ("confirmar?")
 * com contagem regressiva; 2º clique dentro do prazo executa; Esc, blur ou o
 * timeout desarmam. NUNCA use window.confirm (bloqueia o renderer).
 *
 *   <ConfirmButton onConfirm={() => invoke('ops:kill', pid)}>matar</ConfirmButton>
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'confirmar?',
  timeoutMs = 3500,
  size = 'xs',
  disabled,
  className,
  title,
}: {
  onConfirm: () => void | Promise<unknown>
  children: ReactNode
  confirmLabel?: ReactNode
  timeoutMs?: number
  size?: ButtonSize
  disabled?: boolean
  className?: string
  title?: string
}) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const disarm = () => {
    if (timer.current) clearTimeout(timer.current)
    setArmed(false)
  }

  const click = async () => {
    if (busy) return
    if (!armed) {
      setArmed(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => alive.current && setArmed(false), timeoutMs)
      return
    }
    disarm()
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <Button
      variant="danger"
      size={size}
      disabled={disabled}
      loading={busy}
      title={armed ? 'clique de novo para confirmar · Esc cancela' : title}
      onClick={() => void click()}
      onBlur={() => armed && disarm()}
      onKeyDown={(e) => e.key === 'Escape' && armed && (e.stopPropagation(), disarm())}
      aria-live="polite"
      className={cx('relative overflow-hidden', armed && 'border-alert bg-alert/15 hc-fade-in', className)}
    >
      <span className="relative z-[1]">{armed ? confirmLabel : children}</span>
      {armed && (
        <span
          aria-hidden
          className="hc-countdown absolute inset-x-0 bottom-0 h-[2px] bg-alert/80"
          style={{ animationDuration: `${timeoutMs}ms` }}
        />
      )}
    </Button>
  )
}
