import { useId, useRef, useState, type ReactNode } from 'react'
import { cx } from './cx'

/**
 * Tooltip simples (hover/foco, atraso 350ms). Posiciona acima/abaixo do alvo,
 * sem portal — o pai não deve ter overflow:hidden se precisar sair dele.
 * Para dicas triviais prefira o atributo `title`.
 */
export function Tooltip({
  content,
  side = 'bottom',
  children,
  className,
}: {
  content: ReactNode
  side?: 'top' | 'bottom'
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()
  const show = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), 350)
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
  }
  return (
    <span
      className={cx('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && content != null && (
        <span
          role="tooltip"
          id={id}
          className={cx(
            'hc-fade-in hc-glass pointer-events-none absolute left-1/2 z-[70] w-max max-w-[280px] -translate-x-1/2 rounded-md px-2 py-1 text-[10px] leading-snug whitespace-pre-line text-ink',
            side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}
