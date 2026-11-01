import type { ViewId } from '../lib/layout'
import type { ConnState } from '../lib/rpc'
import { VIEWS } from './layout/views'
import type { SwarmBadge } from './layout/useSwarmBadge'
import { usePluginSource } from './panels/source'
import { API, type Quota, type Sistema } from './panels/types'
import { Badge } from './ui/Badge'
import { IconButton } from './ui/IconButton'
import { Kbd } from './ui/Kbd'
import { Tabs, type TabItem } from './ui/Tabs'
import { cx } from './ui/cx'

type Tone = 'ok' | 'warn' | 'off' | 'bad'

interface Props {
  connState: ConnState
  electron: boolean
  narrow: boolean
  railOpen: boolean
  dockOpen: boolean
  focus: boolean
  view: ViewId
  onView: (v: ViewId) => void
  swarm: SwarmBadge
  onOpenPalette: () => void
  onToggleRail: () => void
  onToggleDock: () => void
  onToggleFocus: () => void
  onOpenSettings: () => void
}

// Barra superior = região de arrasto da janela (hiddenInset). Controles são
// no-drag. Padding à esquerda reserva espaço para os traffic lights do macOS.
// Abas de VIEW (Chat · Swarm · Ops · Transcrever) trocam a área central.
export function TopBar(p: Props) {
  const sistema = usePluginSource<Sistema>(API.sistema, 30_000)
  const quota = usePluginSource<Quota>(API.quota, 60_000)

  const ws: { tone: Tone; tip: string } =
    p.connState === 'open'
      ? { tone: 'ok', tip: 'WebSocket do hermes serve local (127.0.0.1) aberto — não mede a VPS' }
      : p.connState === 'connecting' || p.connState === 'idle'
        ? { tone: 'warn', tip: 'conectando ao hermes serve…' }
        : { tone: 'bad', tip: `WebSocket ${p.connState} — reconectando com backoff` }

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

  const swarmCount = (p.swarm.approvals ?? 0) + (p.swarm.active ?? 0)
  const tabs: TabItem<ViewId>[] = VIEWS.map((v) => ({
    id: v.id,
    label: v.label,
    icon: v.icon,
    title: `${v.label} — ${v.hint} (⌘${v.key})`,
    badge:
      v.id === 'swarm' && swarmCount > 0 ? (
        <Badge
          tone={(p.swarm.approvals ?? 0) > 0 ? 'amber' : 'phos'}
          count={(p.swarm.approvals ?? 0) > 0 ? (p.swarm.approvals ?? 0) : (p.swarm.active ?? 0)}
          title={`${p.swarm.approvals ?? 0} aprovação(ões) pendente(s) · ${p.swarm.active ?? 0} run(s) ativa(s)`}
          className={(p.swarm.approvals ?? 0) > 0 ? 'hc-glow-amber' : undefined}
        />
      ) : undefined,
  }))

  const connecting = p.connState === 'connecting' || p.connState === 'idle'

  return (
    <header
      className={cx(
        'app-drag relative flex h-11 shrink-0 items-center gap-3 border-b border-edge pr-3',
        'bg-[linear-gradient(180deg,var(--color-panel2),var(--color-panel))]',
        p.electron ? 'pl-[84px]' : 'pl-3',
      )}
    >
      {p.narrow && !p.focus && (
        <IconButton label="Bots" active={p.railOpen} onClick={p.onToggleRail} title="mostrar bots (⌘B)">
          ☰
        </IconButton>
      )}
      <div className="flex shrink-0 items-center gap-2" title={ws.tip}>
        <span
          className={cx(
            'h-2.5 w-2.5 rotate-45 transition-colors duration-[var(--hc-dur-3)]',
            ws.tone === 'ok' ? 'bg-amber shadow-[0_0_10px_var(--color-amber)]' : ws.tone === 'bad' ? 'bg-alert' : 'bg-amber/60 hc-pulse-dot',
          )}
          aria-hidden
        />
        <span className="hidden text-[13px] text-ink lg:inline">
          hermes<span className="text-faint">/</span>cockpit
        </span>
      </div>

      <Tabs
        items={tabs}
        value={p.view}
        onChange={p.onView}
        variant="pill"
        ariaLabel="Views"
        controls={(id) => `view-${id}`}
        labelClassName="hc-tab-label"
        className="shrink-0"
      />

      <button
        type="button"
        onClick={p.onOpenPalette}
        className="no-drag hc-press group flex h-7 min-w-[120px] flex-1 items-center gap-2 truncate rounded-md border border-edge2 bg-void/40 px-2.5 text-left text-[11px] text-faint hover:border-amber/50 hover:bg-void/60 hover:text-dim"
      >
        <span className="text-faint transition-colors group-hover:text-amber" aria-hidden>
          ⌕
        </span>
        <span className="min-w-0 flex-1 truncate">Comando, bot, sessão…</span>
        <Kbd keys={['⌘', 'K']} className="hidden opacity-80 sm:inline-flex" />
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
          className={cx(
            'no-drag relative overflow-hidden rounded-full border px-2.5 py-0.5 text-[11px] whitespace-nowrap tabular-nums transition-colors',
            quota.error ? 'border-alert/50 text-alert' : pct != null && pct >= 90 ? 'border-alert/70 text-alert' : 'border-amber/60 text-amber',
          )}
        >
          {pct != null && (
            <span
              aria-hidden
              className={cx('absolute inset-y-0 left-0 -z-0 transition-[width] duration-[var(--hc-dur-4)]', pct >= 90 ? 'bg-alert/15' : 'bg-amber/10')}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          )}
          <span className="relative">{gastoBrl != null ? `R$ ${gastoBrl} / ${budgetBrl ?? '?'}` : 'R$ — / —'}</span>
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        {!p.narrow && !p.focus && (
          <IconButton label="Rail" active={p.railOpen} onClick={p.onToggleRail} title="alternar rail (⌘B)">
            ◧
          </IconButton>
        )}
        {!p.focus && (
          <IconButton label="Dock" active={p.dockOpen} onClick={p.onToggleDock} title="alternar dock (⌘J)">
            ◨
          </IconButton>
        )}
        <IconButton label="Foco" active={p.focus} onClick={p.onToggleFocus} title="modo foco (⌘.)">
          ◎
        </IconButton>
        <IconButton label="Configurações" onClick={p.onOpenSettings} title="configurações (⌘,)">
          ⚙
        </IconButton>
      </div>

      {/* reconexão: barra indeterminada fina na base da topbar */}
      {connecting && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-px overflow-hidden">
          <span
            className="block h-full w-1/3 bg-[linear-gradient(90deg,transparent,var(--color-amber),transparent)]"
            style={{ animation: 'hc-kf-indeterminate 1.3s var(--hc-ease-std) infinite' }}
          />
        </span>
      )}
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
    tone === 'ok'
      ? 'bg-phos shadow-[0_0_6px_var(--color-phos)]'
      : tone === 'warn'
        ? 'bg-amber hc-pulse-dot'
        : tone === 'bad'
          ? 'bg-alert hc-pulse-dot'
          : 'bg-faint'
  return (
    <span
      title={tip}
      className={cx(
        'no-drag hc-pill flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] whitespace-nowrap transition-colors duration-[var(--hc-dur-3)]',
        tone === 'bad' ? 'border-alert/40 text-alert/90' : 'border-edge2 text-dim',
      )}
    >
      <span className={`h-1.5 w-1.5 rounded-full transition-colors duration-[var(--hc-dur-3)] ${dot}`} aria-hidden />
      <span className="hc-pill-label">{children}</span>
    </span>
  )
}
