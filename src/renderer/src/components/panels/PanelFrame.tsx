import type { ReactNode } from 'react'
import { SkeletonLines } from '../ui/Skeleton'

// Moldura comum dos cards/painéis: título, fonte à direita, chip de erro e
// estados vazio/carregando honestos. Erro de uma fonte fica neste card.

interface Props {
  titulo: string
  fonte?: string
  error?: string | null
  loading?: boolean
  empty?: boolean
  emptyText?: string
  onRefresh?: () => void
  className?: string
  children?: ReactNode
}

export function PanelFrame({
  titulo,
  fonte,
  error,
  loading,
  empty,
  emptyText = 'sem dados',
  onRefresh,
  className = '',
  children,
}: Props) {
  return (
    <section className={`flex h-full min-h-0 min-w-0 flex-col px-4 py-3 ${className}`} aria-busy={loading || undefined}>
      <header className="mb-2 flex items-center gap-2">
        <h3 className="truncate text-[12px] font-semibold text-ink">{titulo}</h3>
        {error && (
          <button
            type="button"
            onClick={onRefresh}
            title={`${error} — clique para tentar de novo`}
            className="hc-fade-in hc-press flex max-w-[45%] items-center gap-1 truncate rounded border border-alert/40 bg-alert/5 px-1.5 text-[10px] text-alert hover:bg-alert/10"
          >
            <span aria-hidden className="h-1 w-1 shrink-0 rounded-full bg-alert" />
            <span className="truncate">erro: {error}</span>
            <span aria-hidden className="shrink-0 opacity-70">↻</span>
          </button>
        )}
        {fonte && <span className="ml-auto shrink-0 truncate text-[10px] text-faint">{fonte}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <SkeletonLines lines={3} />
        ) : empty ? (
          <div className="hc-fade-in text-[11px] text-faint">{emptyText}</div>
        ) : (
          <div className="hc-fade-in">{children}</div>
        )}
      </div>
    </section>
  )
}

export function Bar({ pct, tone = 'amber' }: { pct: number | null; tone?: 'amber' | 'phos' | 'cyanic' | 'alert' }) {
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const color =
    pct != null && pct >= 90
      ? 'bg-alert'
      : tone === 'phos'
        ? 'bg-phos'
        : tone === 'cyanic'
          ? 'bg-cyanic'
          : tone === 'alert'
            ? 'bg-alert'
            : 'bg-amber'
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-edge">
      {pct != null && (
        <div
          className={`h-full rounded-full transition-[width] duration-[var(--hc-dur-4)] ease-[var(--hc-ease-out)] ${color}`}
          style={{ width: `${v}%` }}
        />
      )}
    </div>
  )
}
