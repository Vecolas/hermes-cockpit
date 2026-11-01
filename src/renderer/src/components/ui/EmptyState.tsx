import type { ReactNode } from 'react'
import { cx } from './cx'

/**
 * Estado vazio/erro/indisponível honesto. `tone="error"` para falha de fonte;
 * `action` para um botão (tentar de novo, configurar…).
 */
export function EmptyState({
  title,
  detail,
  icon,
  action,
  tone = 'neutral',
  compact,
  className,
}: {
  title: ReactNode
  detail?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  tone?: 'neutral' | 'error' | 'warn'
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cx(
        'hc-fade-in flex flex-col items-center justify-center text-center',
        compact ? 'gap-1.5 px-3 py-3' : 'h-full gap-3 px-6 py-8',
        className,
      )}
    >
      {icon && (
        <div
          className={cx(
            'flex items-center justify-center rounded-lg border',
            compact ? 'h-7 w-7 text-[13px]' : 'h-10 w-10 text-[17px]',
            tone === 'error' ? 'border-alert/40 text-alert' : tone === 'warn' ? 'border-amber/40 text-amber' : 'border-edge2 text-faint',
          )}
          aria-hidden
        >
          {icon}
        </div>
      )}
      <div className={cx('label', tone === 'error' && 'text-alert', tone === 'warn' && 'text-amber')}>{title}</div>
      {detail && <div className={cx('max-w-sm leading-relaxed text-dim', compact ? 'text-[10px]' : 'text-[11px]')}>{detail}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}
