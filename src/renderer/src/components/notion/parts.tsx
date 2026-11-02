import type { ReactNode } from 'react'
import { DUE_CLASS, dueLabel, dueTone, notionColor, type NotionOpt, type NotionTask } from '../../lib/notion'
import { cx } from '../ui/cx'

// Peças visuais compartilhadas entre NotionView e NotionTasksWidget.

const TONE_TXT = {
  alert: 'text-alert border-alert/40 bg-alert/10',
  amber: 'text-amber border-amber/40 bg-amber/10',
  phos: 'text-phos border-phos/40 bg-phos/10',
  cyanic: 'text-cyanic border-cyanic/40 bg-cyanic/10',
  neutral: 'text-dim border-edge2 bg-panel2/60',
} as const

const TONE_DOT = {
  alert: 'bg-alert',
  amber: 'bg-amber',
  phos: 'bg-phos',
  cyanic: 'bg-cyanic',
  neutral: 'bg-faint',
} as const

export function OptChip({
  name,
  color,
  active,
  onClick,
  small,
  title,
}: {
  name: string
  color?: string
  active?: boolean
  onClick?: () => void
  small?: boolean
  title?: string
}) {
  const tone = notionColor(color)
  const cls = cx(
    'inline-flex shrink-0 items-center gap-1 rounded border leading-none tracking-wider uppercase',
    small ? 'px-1 py-[2px] text-[8.5px]' : 'px-1.5 py-[3px] text-[9px]',
    onClick ? (active ? TONE_TXT[tone] : 'border-edge text-faint hover:border-edge2 hover:text-dim') : TONE_TXT[tone],
  )
  const dot = <span aria-hidden className={cx('h-1 w-1 rounded-full', active === false ? 'bg-faint' : TONE_DOT[tone])} />
  if (!onClick)
    return (
      <span className={cls} title={title}>
        {dot}
        {name}
      </span>
    )
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={cx(cls, 'hc-press no-drag')} title={title}>
      {dot}
      {name}
    </button>
  )
}

export function optColor(list: NotionOpt[] | undefined, name: string): string | undefined {
  return list?.find((o) => o.name === name)?.color
}

/** prazo com cor por urgência (atrasada/hoje/em breve) */
export function DueChip({ date, done, className }: { date: string | null; done?: boolean; className?: string }) {
  const tone = dueTone(date, done)
  if (!date) return null
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums', DUE_CLASS[tone], className)}
      title={date}
    >
      {tone === 'overdue' && <span aria-hidden className="hc-pulse-dot h-1 w-1 rounded-full bg-alert" />}
      {dueLabel(date)}
    </span>
  )
}

/** checkbox redondo com traço animado (stroke-dashoffset) */
export function TaskCheck({
  done,
  busy,
  onToggle,
  label,
  size = 14,
}: {
  done: boolean
  busy?: boolean
  onToggle: () => void
  label: string
  size?: number
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cx(
        'no-drag hc-press group relative flex shrink-0 items-center justify-center rounded-full border transition-colors duration-[var(--hc-dur-2)]',
        done ? 'border-phos/70 bg-phos/15' : 'border-edge2 hover:border-phos/60 hover:bg-phos/5',
        busy && 'opacity-60',
      )}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 12 12" width={size - 4} height={size - 4} aria-hidden className="overflow-visible">
        <path
          d="M2.5 6.2 5 8.6 9.6 3.6"
          fill="none"
          stroke="var(--color-phos)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          style={{
            strokeDasharray: 1,
            strokeDashoffset: done ? 0 : 1,
            transition: 'stroke-dashoffset var(--hc-dur-3) var(--hc-ease-out)',
          }}
        />
      </svg>
    </button>
  )
}

export function PrioMark({ task }: { task: NotionTask }) {
  const p = task.prioridade[0]?.toUpperCase()
  if (!p) return null
  const bars = p === 'HIGH' ? 3 : p === 'MEDIUM' ? 2 : 1
  const tone = p === 'HIGH' ? 'bg-alert' : p === 'MEDIUM' ? 'bg-amber' : 'bg-phos/70'
  return (
    <span className="inline-flex shrink-0 items-end gap-[1.5px]" title={`prioridade ${task.prioridade.join(', ')}`} aria-label={`prioridade ${p}`}>
      {[1, 2, 3].map((i) => (
        <span key={i} aria-hidden className={cx('w-[2.5px] rounded-[1px]', i <= bars ? tone : 'bg-edge2')} style={{ height: 3 + i * 2 }} />
      ))}
    </span>
  )
}

export function Section({ label, right, children, className }: { label: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="label">{label}</span>
        <span className="h-px flex-1 bg-gradient-to-r from-edge to-transparent" aria-hidden />
        {right}
      </div>
      {children}
    </div>
  )
}

/** ícone N do Notion em traço (SVG inline) */
export function NotionGlyph({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M3 2.5h7.5L13 5v8.5H3z" />
      <path d="M5.5 11V5.5l5 5.5V5.5" strokeLinecap="round" />
    </svg>
  )
}
