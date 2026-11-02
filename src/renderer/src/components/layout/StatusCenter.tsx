import { useEffect, useRef, useState, type ReactNode } from 'react'
import { setAutoMode, useAutoMode } from '../../lib/automode'
import type { ConnState } from '../../lib/rpc'
import { Bar } from '../panels/PanelFrame'
import { usePluginSource } from '../panels/source'
import { API, fmtReset, quotaWindows, worstWindow, type Quota, type Sistema } from '../panels/types'
import { Icon, type IconName } from '../ui/Icon'
import { cx } from '../ui/cx'

type Tone = 'ok' | 'warn' | 'off' | 'bad'

const RANK: Record<Tone, number> = { ok: 0, off: 1, warn: 2, bad: 3 }
const DOT: Record<Tone, string> = {
  ok: 'bg-phos shadow-[0_0_6px_var(--color-phos)]',
  warn: 'bg-amber hc-pulse-dot',
  bad: 'bg-alert hc-pulse-dot',
  off: 'bg-faint',
}

interface Row {
  id: string
  icon: IconName
  label: string
  tone: Tone
  value: ReactNode
  detail: string
  windows?: Array<{ key: string; prov: string; label: string; pct: number; reset?: string | null }>
}

/**
 * "Status center" da topbar: um único botão com o pior estado agregado
 * (serve local, Mac executor, Telegram, cota) + gasto do mês; o popover
 * detalha cada fonte e traz o auto mode. Fonte que falha = linha de erro.
 */
export function StatusCenter({ connState }: { connState: ConnState }) {
  const sistema = usePluginSource<Sistema>(API.sistema, 30_000)
  const quota = usePluginSource<Quota>(API.quota, 60_000)
  const auto = useAutoMode()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const ws: Row = {
    id: 'ws',
    icon: 'wifi',
    label: 'serve local',
    ...(connState === 'open'
      ? { tone: 'ok' as Tone, value: 'aberto', detail: 'WebSocket do hermes serve local (127.0.0.1) — não mede a VPS' }
      : connState === 'connecting' || connState === 'idle'
        ? { tone: 'warn' as Tone, value: 'conectando', detail: 'conectando ao hermes serve…' }
        : { tone: 'bad' as Tone, value: connState, detail: `WebSocket ${connState} — reconectando com backoff` }),
  }
  const s = sistema.data
  const mac: Row = {
    id: 'mac',
    icon: 'cpu',
    label: 'Mac executor',
    ...(sistema.error
      ? { tone: 'bad' as Tone, value: 'erro', detail: `/sistema: ${sistema.error}` }
      : !s
        ? { tone: 'off' as Tone, value: '…', detail: 'aguardando /sistema' }
        : s.gateway
          ? {
              tone: 'ok' as Tone,
              value: `CPU ${pct(s.cpu_percent)} · RAM ${pct(s.mem_percent)}`,
              detail: `gateway ${s.gateway.code_version ?? ''} pid ${s.gateway.pid ?? '?'}`,
            }
          : { tone: 'warn' as Tone, value: 'sem gateway', detail: 'Mac respondendo, mas sem estado do gateway (gateway_state.json)' }),
  }
  const tg: Row = {
    id: 'tg',
    icon: 'telegram',
    label: 'Telegram',
    tone: 'off',
    value: 'sem fonte',
    detail: 'o plugin cockpit ainda não expõe o estado do Telegram (plataformas do gateway)',
  }
  const q = quota.data
  const spend =
    typeof q?.gasto_brl === 'number' && typeof q.budget_brl === 'number' && q.budget_brl > 0 ? (q.gasto_brl / q.budget_brl) * 100 : null
  const worstProv = Math.max(-1, ...(q?.provedores ?? []).map((p) => worstWindow(p)?.pct ?? -1))
  const cota: Row = {
    id: 'quota',
    icon: 'money',
    label: 'Cota do mês',
    ...(quota.error
      ? { tone: 'bad' as Tone, value: 'erro', detail: `/quota: ${quota.error}` }
      : !q
        ? { tone: 'off' as Tone, value: '…', detail: 'aguardando /quota' }
        : {
            tone: ((spend ?? 0) >= 90 || worstProv >= 90 ? 'bad' : (spend ?? 0) >= 75 || worstProv >= 75 ? 'warn' : 'ok') as Tone,
            value: q.gasto_brl != null ? `R$ ${q.gasto_brl.toFixed(0)} / ${q.budget_brl?.toFixed(0) ?? '?'}` : '—',
            detail: `US$ ${q.gasto_usd?.toFixed(2) ?? '?'} × câmbio ${q.fx ?? '?'} · mês ${q.mes ?? '?'}`,
            windows: (q.provedores ?? []).flatMap((p) => quotaWindows(p).map((w) => ({ key: `${p.nome}-${w.label}`, prov: p.nome ?? '?', label: w.label, pct: w.pct, reset: w.reset }))),
          }),
  }
  const rows = [ws, mac, tg, cota]
  const worst = rows.reduce<Tone>((w, r) => (RANK[r.tone] > RANK[w] ? r.tone : w), 'ok')

  return (
    <div ref={box} className="no-drag relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={rows.map((r) => `${r.label}: ${r.value}`).join('\n')}
        className={cx(
          'hc-press flex h-7 items-center gap-2 rounded-md border px-2 text-[11px] whitespace-nowrap',
          open ? 'border-edge2 bg-panel2 text-ink' : 'border-transparent text-dim hover:border-edge2 hover:bg-panel2/60 hover:text-ink',
        )}
      >
        <span className="flex items-center gap-[3px]" aria-hidden>
          {rows.map((r) => (
            <span key={r.id} className={cx('h-1.5 w-1.5 rounded-full transition-colors duration-[var(--hc-dur-3)]', DOT[r.tone])} />
          ))}
        </span>
        <span className={cx('hc-pill-label tabular-nums', cota.tone === 'bad' && 'text-alert')}>{q ? cota.value : 'status'}</span>
        {auto && (
          <span className="flex items-center gap-1 rounded-sm bg-phos/10 px-1 text-[9px] font-semibold tracking-[0.14em] text-phos uppercase">
            <Icon name="auto" size={10} />
            auto
          </span>
        )}
        <Icon name="chevronDown" size={11} className={cx('text-faint transition-transform duration-[var(--hc-dur-2)]', open && 'rotate-180')} />
        <span className="sr-only">status geral: {worst}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Status" className="hc-glass hc-pop absolute top-9 right-0 z-40 w-[300px] rounded-lg p-1.5">
          <div className="label px-2 pt-1 pb-1.5">status</div>
          <ul className="hc-stagger">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-panel2/60" title={r.detail}>
                <Icon name={r.icon} size={13} className="mt-[1px] text-faint" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-ink">{r.label}</span>
                    <span className={cx('ml-auto h-1.5 w-1.5 shrink-0 rounded-full', DOT[r.tone])} />
                    <span className={cx('shrink-0 tabular-nums', r.tone === 'bad' ? 'text-alert' : 'text-dim')}>{r.value}</span>
                  </div>
                  <div className="truncate text-[10px] text-faint">{r.detail}</div>
                  {r.windows && r.windows.length > 0 && (
                    <ul className="mt-1 space-y-0.5" aria-label="janelas de uso por provedor">
                      {r.windows.map((w) => {
                        const rs = fmtReset(w.reset)
                        return (
                          <li key={w.key} className="flex items-baseline gap-1.5 text-[10px]" title={rs?.full}>
                            <span className="min-w-0 flex-1 truncate text-dim">
                              {w.prov} · {w.label}
                            </span>
                            {rs && <span className="shrink-0 text-[9px] text-faint">reset {rs.short}</span>}
                            <span className={cx('w-8 shrink-0 text-right tabular-nums', w.pct >= 90 ? 'text-alert' : 'text-dim')}>{Math.round(w.pct)}%</span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {r.id === 'quota' && spend != null && (
                    <div className="mt-1">
                      <Bar pct={spend} tone="amber" />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-edge px-2 pt-2 pb-1">
            <button
              type="button"
              onClick={() => void setAutoMode(!auto)}
              className={cx(
                'hc-press flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[11px]',
                auto ? 'border-phos/50 bg-phos/10 text-phos' : 'border-edge2 text-dim hover:text-ink',
              )}
              title={
                auto
                  ? 'Auto mode LIGADO — Hermes aprova via guardian (smart) e o swarm usa --permission-mode auto.'
                  : 'Auto mode desligado — aprovações manuais no cockpit.'
              }
            >
              <Icon name="auto" size={13} />
              <span className="flex-1">Auto mode {auto ? 'ligado' : 'desligado'}</span>
              <span
                aria-hidden
                className={cx(
                  'relative h-3.5 w-6 rounded-full border transition-colors',
                  auto ? 'border-phos/60 bg-phos/30' : 'border-edge2 bg-void',
                )}
              >
                <span
                  className={cx(
                    'absolute top-[1px] h-2.5 w-2.5 rounded-full transition-[left,background-color] duration-[var(--hc-dur-2)] ease-[var(--hc-ease-spring)]',
                    auto ? 'left-[11px] bg-phos' : 'left-[1px] bg-faint',
                  )}
                />
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function pct(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : '—'
}
