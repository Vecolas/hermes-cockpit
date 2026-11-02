import { useEffect, useId, useRef, useState } from 'react'
import { cx } from './cx'

// Mini-visualizações sem dependência (SVG inline): contador animado, gauge
// radial e sparkline. Todas respeitam prefers-reduced-motion e aceitam null
// (sem dado = estado vazio honesto, nunca zero inventado).

const reduced = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

/** Número que anima do valor anterior até o atual (hc-count). */
export function CountUp({
  value,
  format = (n) => String(Math.round(n)),
  durationMs = 700,
  className,
}: {
  value: number | null | undefined
  format?: (n: number) => string
  durationMs?: number
  className?: string
}) {
  const [shown, setShown] = useState<number | null>(typeof value === 'number' ? value : null)
  const from = useRef<number>(typeof value === 'number' ? value : 0)
  useEffect(() => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      setShown(null)
      return
    }
    const start = from.current
    if (reduced() || start === value) {
      from.current = value
      setShown(value)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / durationMs)
      const e = 1 - Math.pow(1 - k, 3)
      const v = start + (value - start) * e
      setShown(v)
      from.current = v
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, durationMs])
  return <span className={cx('hc-count', className)}>{shown == null ? '—' : format(shown)}</span>
}

/** Gauge radial (arco de 270°). pct null = trilho vazio + "—". */
export function Gauge({
  pct,
  size = 64,
  label,
  sub,
  tone,
}: {
  pct: number | null
  size?: number
  label?: string
  sub?: string
  /** cor do arco (CSS); padrão: fósforo → âmbar → alerta conforme uso */
  tone?: string
}) {
  const r = size / 2 - 5
  const c = 2 * Math.PI * r
  const arc = c * 0.75
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const color =
    tone ?? (pct == null ? 'var(--color-faint)' : v >= 90 ? 'var(--color-alert)' : v >= 70 ? 'var(--color-amber)' : 'var(--color-phos)')
  const gid = useId().replace(/:/g, '')
  const [drawn, setDrawn] = useState(reduced() ? v : 0)
  useEffect(() => {
    const id = requestAnimationFrame(() => setDrawn(v))
    return () => cancelAnimationFrame(id)
  }, [v])
  return (
    <div className="flex flex-col items-center gap-1" title={[label, pct != null ? `${Math.round(v)}%` : 'sem dado', sub].filter(Boolean).join(' · ')}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="rotate-[135deg]">
          <defs>
            <linearGradient id={`g${gid}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.55" />
              <stop offset="100%" stopColor={color} />
            </linearGradient>
          </defs>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--color-edge)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={`${arc} ${c}`}
          />
          {pct != null && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={`url(#g${gid})`}
              strokeWidth={4}
              strokeLinecap="round"
              strokeDasharray={`${(arc * drawn) / 100} ${c}`}
              style={{
                transition: 'stroke-dasharray var(--hc-dur-4) var(--hc-ease-out)',
                filter: `drop-shadow(0 0 4px color-mix(in srgb, ${color} 55%, transparent))`,
              }}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-ink">
          <CountUp value={pct == null ? null : v} format={(n) => `${Math.round(n)}%`} />
        </div>
      </div>
      {label && <div className="max-w-[88px] truncate text-[10px] text-dim">{label}</div>}
      {sub && <div className="-mt-1 max-w-[88px] truncate text-[9px] text-faint">{sub}</div>}
    </div>
  )
}

/** Sparkline em SVG: linha + área. `values` vazio = trilho tracejado. */
export function Sparkline({
  values,
  width = 160,
  height = 36,
  color = 'var(--color-phos)',
  className,
  title,
}: {
  values: number[]
  width?: number
  height?: number
  color?: string
  className?: string
  title?: string
}) {
  const gid = useId().replace(/:/g, '')
  const max = Math.max(1, ...values)
  const n = values.length
  const pts = values.map((v, i) => [n <= 1 ? width : (i / (n - 1)) * width, height - 2 - (v / max) * (height - 6)] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = pts.length ? `${line} L${width},${height} L0,${height} Z` : ''
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cx('block h-full w-full overflow-visible', className)}
      role="img"
      aria-label={title}
    >
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={`s${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {n === 0 ? (
        <line x1="0" x2={width} y1={height - 2} y2={height - 2} stroke="var(--color-edge2)" strokeDasharray="3 3" />
      ) : (
        <>
          <path d={area} fill={`url(#s${gid})`} />
          <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" className="hc-draw" vectorEffect="non-scaling-stroke" />
          {pts.length > 0 && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2.2} fill={color} />}
        </>
      )}
    </svg>
  )
}
