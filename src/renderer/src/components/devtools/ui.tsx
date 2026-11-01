import { useEffect, useRef, useState, type ReactNode } from 'react'
import { parseDiff, type DiffLine } from '../../lib/devtools'

// Peças comuns das abas do dock. Visual grafite: labels uppercase/tracking,
// bordas edge/edge2, mono.

export function ToolButton({
  children,
  onClick,
  title,
  disabled,
  active,
  tone = 'default',
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  title?: string
  disabled?: boolean
  active?: boolean
  tone?: 'default' | 'amber' | 'phos' | 'alert'
  className?: string
}) {
  const toneCls =
    tone === 'amber'
      ? 'border-amber/40 text-amber hover:bg-amber/10'
      : tone === 'phos'
        ? 'border-phos/40 text-phos hover:bg-phos/10'
        : tone === 'alert'
          ? 'border-alert/50 text-alert hover:bg-alert/10'
          : active
            ? 'border-edge2 bg-panel2 text-ink'
            : 'border-edge text-dim hover:border-edge2 hover:text-ink'
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`shrink-0 rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneCls} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * Ação destrutiva com confirmação inline de 2 cliques (sem window.confirm):
 * 1º clique arma ("confirmar?") por 4s; 2º executa.
 */
export function ConfirmButton({
  children,
  confirmLabel = 'confirmar?',
  onConfirm,
  title,
  disabled,
}: {
  children: ReactNode
  confirmLabel?: string
  onConfirm: () => void
  title?: string
  disabled?: boolean
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <ToolButton
      tone={armed ? 'alert' : 'default'}
      title={title}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          window.clearTimeout(timer.current)
          setArmed(false)
          onConfirm()
          return
        }
        setArmed(true)
        timer.current = window.setTimeout(() => setArmed(false), 4000)
      }}
    >
      {armed ? confirmLabel : children}
    </ToolButton>
  )
}

export function ErrorState({ title, detail, onRetry }: { title: string; detail?: string | null; onRetry?: () => void }) {
  return (
    <div className="hc-fade-in m-3 rounded border border-alert/40 bg-alert/5 px-3 py-2 text-[11px]">
      <div className="label text-alert">{title}</div>
      {detail && <div className="mt-1 break-words text-dim">{detail}</div>}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 text-[10px] uppercase tracking-wider text-amber hover:underline">
          tentar de novo
        </button>
      )}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="hc-fade-in px-4 py-6 text-center text-[11px] leading-relaxed text-faint">{children}</div>
}

export function Loading({ text = 'carregando…' }: { text?: string }) {
  return <div className="hc-shimmer px-4 py-3 text-[11px] text-faint">{text}</div>
}

// ─── Diff unificado colorido ─────────────────────────────────────────────────

const LINE_CLS: Record<DiffLine['kind'], string> = {
  add: 'bg-phos/10 text-phos',
  del: 'bg-alert/10 text-alert',
  ctx: 'text-dim',
  hunk: 'bg-cyanic/5 text-cyanic',
  meta: 'text-faint',
}

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ', hunk: '', meta: '' }

export function DiffView({ diff, maxLines = 4000 }: { diff: string; maxLines?: number }) {
  const lines = parseDiff(diff)
  const shown = lines.slice(0, maxLines)
  if (lines.length === 0) return <EmptyState>diff vazio (arquivo binário, renomeado ou sem mudanças de conteúdo).</EmptyState>
  return (
    <div className="min-w-max font-mono text-[11px] leading-[1.55]">
      {shown.map((l, i) => (
        <div key={i} className={`flex whitespace-pre ${LINE_CLS[l.kind]}`}>
          {l.kind === 'hunk' || l.kind === 'meta' ? (
            <span className="px-2">{l.text}</span>
          ) : (
            <>
              <span className="w-10 shrink-0 select-none pr-1 text-right text-faint/70">{l.oldNo ?? ''}</span>
              <span className="w-10 shrink-0 select-none pr-1 text-right text-faint/70">{l.newNo ?? ''}</span>
              <span className="w-4 shrink-0 select-none text-center">{SIGN[l.kind]}</span>
              <span className="pr-4">{l.text}</span>
            </>
          )}
        </div>
      ))}
      {lines.length > maxLines && (
        <div className="px-2 py-1 text-faint">… {lines.length - maxLines} linhas omitidas</div>
      )}
    </div>
  )
}

/** Letra de status do git com cor. */
export function StatusLetter({ s }: { s: string }) {
  const c = s === 'A' || s === '?' ? 'text-phos' : s === 'D' ? 'text-alert' : s === 'U' ? 'text-alert' : s === 'R' ? 'text-cyanic' : 'text-amber'
  return <span title={s === '?' ? 'novo (não rastreado)' : s === 'U' ? 'conflito' : undefined} className={`w-3 shrink-0 text-center font-semibold ${c}`}>{s === '?' ? 'N' : s}</span>
}
