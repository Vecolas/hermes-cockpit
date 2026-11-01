import type { ConnState } from '../lib/rpc'
import { usePluginSource } from './panels/source'
import { API, type Quota, type Sistema } from './panels/types'

type Tone = 'ok' | 'warn' | 'off' | 'bad'

interface Props {
  connState: ConnState
  electron: boolean
  narrow: boolean
  railOpen: boolean
  dockOpen: boolean
  focus: boolean
  onOpenPalette: () => void
  onToggleRail: () => void
  onToggleDock: () => void
  onToggleFocus: () => void
  onOpenSettings: () => void
}

// Barra superior = região de arrasto da janela (hiddenInset). Controles são
// no-drag. Padding à esquerda reserva espaço para os traffic lights do macOS.
export function TopBar(p: Props) {
  const sistema = usePluginSource<Sistema>(API.sistema, 30_000)
  const quota = usePluginSource<Quota>(API.quota, 60_000)

  const ws: { tone: Tone; tip: string } =
    p.connState === 'open'
      ? { tone: 'ok', tip: 'WebSocket do hermes serve local (127.0.0.1) aberto — não mede a VPS' }
      : p.connState === 'connecting' || p.connState === 'idle'
        ? { tone: 'warn', tip: 'conectando ao hermes serve…' }
        : { tone: 'bad', tip: `WebSocket ${p.connState}` }

  const mac: { tone: Tone; tip: string } = sistema.error
    ? { tone: 'bad', tip: `/sistema: ${sistema.error}` }
    : !sistema.data
      ? { tone: 'off', tip: 'aguardando /sistema' }
      : sistema.data.gateway
        ? {
            tone: 'ok',
            tip: `gateway ${sistema.data.gateway.code_version ?? ''} pid ${sistema.data.gateway.pid ?? '?'} · CPU ${pctText(sistema.data.cpu_percent)} · RAM ${pctText(sistema.data.mem_percent)}`,
          }
        : { tone: 'warn', tip: 'Mac respondendo, mas sem estado do gateway (gateway_state.json)' }

  const q = quota.data
  const gastoBrl = money(q?.gasto_brl, 0)
  const budgetBrl = money(q?.budget_brl, 0)
  const pct =
    typeof q?.gasto_brl === 'number' && typeof q.budget_brl === 'number' && q.budget_brl > 0
      ? (q.gasto_brl / q.budget_brl) * 100
      : null

  return (
    <header
      className={`app-drag flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-panel pr-3 ${
        p.electron ? 'pl-[84px]' : 'pl-3'
      }`}
    >
      {p.narrow && !p.focus && (
        <IconBtn label="Bots" active={p.railOpen} onClick={p.onToggleRail} title="mostrar bots (⌘B)">
          ☰
        </IconBtn>
      )}
      <div className="flex shrink-0 items-center gap-2">
        <span className="h-2.5 w-2.5 bg-amber glow-amber" aria-hidden />
        <span className="text-[13px] text-ink">hermes/cockpit</span>
      </div>

      <button
        type="button"
        onClick={p.onOpenPalette}
        className="no-drag flex h-7 min-w-[140px] flex-1 items-center gap-2 truncate rounded-md border border-dashed border-edge2 bg-void/40 px-2.5 text-left text-[11px] text-faint hover:border-amber/50 hover:text-dim"
      >
        <span className="text-dim">⌘K</span>
        <span className="truncate">Comando ou bot…</span>
      </button>

      <div className="hc-pills flex shrink-0 items-center gap-1.5">
        <Pill tone={ws.tone} tip={ws.tip}>
          serve local
        </Pill>
        <Pill tone={mac.tone} tip={mac.tip}>
          Mac executor
        </Pill>
        <Pill tone="off" tip="o plugin cockpit ainda não expõe o estado do Telegram (plataformas do gateway)">
          Telegram
        </Pill>
        <span
          title={
            quota.error
              ? `/quota: ${quota.error}`
              : q
                ? `gasto do mês ${q.mes ?? ''}: US$ ${money(q.gasto_usd, 2) ?? '?'} × câmbio ${q.fx ?? '?'}`
                : 'aguardando /quota'
          }
          className={`no-drag rounded-full border px-2.5 py-0.5 text-[11px] whitespace-nowrap ${
            pct != null && pct >= 90 ? 'border-alert/70 text-alert' : 'border-amber/70 text-amber'
          }`}
        >
          {gastoBrl != null ? `R$ ${gastoBrl} / ${budgetBrl ?? '?'} mês` : 'R$ — / — mês'}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!p.narrow && !p.focus && (
          <IconBtn label="Rail" active={p.railOpen} onClick={p.onToggleRail} title="alternar rail (⌘B)">
            ◧
          </IconBtn>
        )}
        {!p.focus && (
          <IconBtn label="Dock" active={p.dockOpen} onClick={p.onToggleDock} title="alternar dock (⌘J)">
            ◨
          </IconBtn>
        )}
        <IconBtn label="Foco" active={p.focus} onClick={p.onToggleFocus} title="modo foco (⌘.)">
          ◎
        </IconBtn>
        <IconBtn label="Configurações" onClick={p.onOpenSettings} title="configurações (⌘,)">
          ⚙
        </IconBtn>
      </div>
    </header>
  )
}

function pctText(v: unknown): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : '—'
}

function money(v: unknown, digits: number): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : null
}

function Pill({ tone, tip, children }: { tone: Tone; tip: string; children: React.ReactNode }) {
  const dot =
    tone === 'ok' ? 'bg-phos glow-phos' : tone === 'warn' ? 'bg-amber' : tone === 'bad' ? 'bg-alert' : 'bg-faint'
  return (
    <span
      title={tip}
      className="no-drag hc-pill flex items-center gap-1.5 rounded-full border border-edge2 px-2.5 py-0.5 text-[11px] whitespace-nowrap text-dim"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
      <span className="hc-pill-label">{children}</span>
    </span>
  )
}

function IconBtn({
  label,
  title,
  active,
  onClick,
  children,
}: {
  label: string
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`no-drag flex h-7 w-7 items-center justify-center rounded-md border text-[13px] transition-colors ${
        active ? 'border-amber/60 text-amber' : 'border-transparent text-faint hover:border-edge2 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}
