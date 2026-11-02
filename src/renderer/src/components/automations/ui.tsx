import type { HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { botTitle } from '../../lib/bots'
import { fmtCountdown, useNow } from '../../lib/automations'
import { spaceOfBot } from '../../lib/space'
import { cx } from '../ui'

// Peças visuais da view Automações (campos, chips, contagem regressiva).

const FIELD = 'w-full rounded-md border border-edge2 bg-void/60 px-2 py-1.5 text-[12px] text-ink outline-none transition-colors placeholder:text-faint focus:border-amber/60 disabled:opacity-50'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD, props.className)} />
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select {...props} className={cx(FIELD, 'pr-6', props.className)}>
      {children}
    </select>
  )
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(FIELD, 'resize-y leading-relaxed', props.className)} />
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="label mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10.5px] leading-snug text-faint">{hint}</span>}
    </label>
  )
}

const SPACE_TONE: Record<string, string> = {
  houer: 'border-amber/40 text-amber',
  pessoal: 'border-cyanic/40 text-cyanic',
  shared: 'border-edge2 text-dim',
}

/** chip do bot com cor do espaço */
export function BotChip({ name, className }: { name: string; className?: string }) {
  const sp = spaceOfBot(name)
  return (
    <span
      className={cx('inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[10px] uppercase tracking-[0.12em]', SPACE_TONE[sp], className)}
      title={`${botTitle(name)} · ${sp === 'shared' ? 'compartilhado' : sp}`}
    >
      {name}
    </span>
  )
}

/** contagem regressiva ao vivo até `at` (pulsa nos últimos 60s) */
export function Countdown({ at, className }: { at: Date | null; className?: string }) {
  const now = useNow()
  if (!at || Number.isNaN(at.getTime())) return <span className={cx('tabular-nums text-faint', className)}>—</span>
  const ms = at.getTime() - now
  const soon = ms < 60_000
  return (
    <span
      className={cx('tabular-nums transition-colors', soon ? 'text-phos' : ms < 3_600_000 ? 'text-amber' : 'text-dim', soon && ms > 0 && 'hc-pulse-dot', className)}
      title={at.toLocaleString('pt-BR')}
    >
      {ms <= 0 ? 'agora' : `em ${fmtCountdown(ms)}`}
    </span>
  )
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="label">{children}</span>
      <span className="h-px flex-1 bg-edge" />
      {right}
    </div>
  )
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx('hc-card rounded-lg border border-edge bg-panel/80', className)}>
      {children}
    </div>
  )
}
