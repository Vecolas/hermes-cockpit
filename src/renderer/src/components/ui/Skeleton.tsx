import { cx } from './cx'

/** Bloco de carregamento (hc-shimmer). Passe tamanho via className (h-3 w-24). */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx('hc-shimmer block rounded', className ?? 'h-3 w-full')} />
}

/** N linhas de skeleton com larguras variadas — estado "carregando" de listas. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  const widths = ['w-11/12', 'w-8/12', 'w-10/12', 'w-6/12', 'w-9/12']
  return (
    <div role="status" aria-label="carregando" className={cx('space-y-2 py-0.5', className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cx('h-2.5', widths[i % widths.length])} />
      ))}
    </div>
  )
}
