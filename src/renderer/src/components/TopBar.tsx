import type { ReactNode } from 'react'
import type { ViewId } from '../lib/layout'
import type { ConnState } from '../lib/rpc'
import { openChatWindow } from '../lib/windows'
import { SpaceSwitch } from './layout/SpaceSwitch'
import { StatusCenter } from './layout/StatusCenter'
import type { SwarmBadge } from './layout/useSwarmBadge'
import { ViewNav } from './layout/ViewNav'
import { Badge } from './ui/Badge'
import { Icon } from './ui/Icon'
import { IconButton } from './ui/IconButton'
import { Kbd } from './ui/Kbd'
import { cx } from './ui/cx'

interface Props {
  connState: ConnState
  electron: boolean
  narrow: boolean
  railOpen: boolean
  dockOpen: boolean
  focus: boolean
  view: ViewId
  /** views visíveis, na ordem do usuário */
  views: ViewId[]
  onView: (v: ViewId) => void
  onReorderViews: (order: ViewId[]) => void
  swarm: SwarmBadge
  voiceOpen: boolean
  onToggleVoice: () => void
  onOpenPalette: () => void
  onToggleRail: () => void
  onToggleDock: () => void
  onToggleFocus: () => void
  onOpenSettings: () => void
}

// Barra superior = região de arrasto da janela (hiddenInset). Controles são
// no-drag. Da esquerda para a direita: marca · espaço · views · busca ·
// status center · ações (voz, janela, layout, configurações).
export function TopBar(p: Props) {
  const approvals = p.swarm.approvals ?? 0
  const active = p.swarm.active ?? 0
  const badges: Partial<Record<ViewId, ReactNode>> = {}
  if (approvals + active > 0) {
    badges.swarm = (
      <Badge
        tone={approvals > 0 ? 'amber' : 'phos'}
        count={approvals > 0 ? approvals : active}
        title={`${approvals} aprovação(ões) pendente(s) · ${active} run(s) ativa(s)`}
        className={approvals > 0 ? 'hc-glow-amber' : undefined}
      />
    )
  }
  const connecting = p.connState === 'connecting' || p.connState === 'idle'
  const wsTone = p.connState === 'open' ? 'ok' : connecting ? 'warn' : 'bad'

  return (
    <header
      className={cx(
        'app-drag relative flex h-11 shrink-0 items-center gap-2.5 border-b border-edge pr-2.5',
        'bg-[linear-gradient(180deg,var(--color-panel2),var(--color-panel))]',
        p.electron ? 'pl-[84px]' : 'pl-3',
      )}
    >
      {p.narrow && !p.focus && (
        <IconButton label="Bots" active={p.railOpen} onClick={p.onToggleRail} title="mostrar bots (⌘B)">
          <Icon name="rail" />
        </IconButton>
      )}
      <div className="flex shrink-0 items-center gap-2" title={`hermes cockpit · serve ${p.connState}`}>
        <span
          className={cx(
            'h-2.5 w-2.5 rotate-45 rounded-[1px] transition-colors duration-[var(--hc-dur-3)]',
            wsTone === 'ok' ? 'bg-space shadow-[0_0_10px_var(--color-space)]' : wsTone === 'bad' ? 'bg-alert' : 'hc-pulse-dot bg-space/60',
          )}
          aria-hidden
        />
        <span className="hidden text-[12.5px] tracking-[0.02em] text-ink 2xl:inline">
          hermes<span className="text-faint">/</span>cockpit
        </span>
      </div>

      <SpaceSwitch compact={p.narrow} />

      <span aria-hidden className="h-4 w-px shrink-0 bg-edge2/70" />

      <ViewNav views={p.views} value={p.view} onChange={p.onView} onReorder={p.onReorderViews} badges={badges} />

      <button
        type="button"
        onClick={p.onOpenPalette}
        className="no-drag hc-press group flex h-7 min-w-[36px] flex-1 items-center gap-2 truncate rounded-md border border-edge2/80 bg-void/40 px-2.5 text-left text-[11px] text-faint hover:border-[color-mix(in_srgb,var(--color-space)_45%,var(--color-edge2))] hover:bg-void/60 hover:text-dim"
        title="paleta de comandos (⌘K)"
      >
        <Icon name="search" size={13} className="transition-colors group-hover:text-space" />
        <span className="hc-pill-label min-w-0 flex-1 truncate">Comando, bot, sessão…</span>
        <Kbd keys={['⌘', 'K']} className="hidden opacity-80 lg:inline-flex" />
      </button>

      <StatusCenter connState={p.connState} />

      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label="Voz"
          active={p.voiceOpen}
          onClick={p.onToggleVoice}
          title="modo voz (⌘⇧V)"
          className={p.voiceOpen ? 'hc-glow-space' : undefined}
        >
          <Icon name="mic" />
        </IconButton>
        <IconButton label="Nova janela" onClick={() => openChatWindow()} title="nova janela de chat (⌘⇧N)">
          <Icon name="window" />
        </IconButton>
        <span aria-hidden className="mx-1 h-4 w-px bg-edge2/70" />
        {!p.narrow && !p.focus && (
          <IconButton label="Rail" active={p.railOpen} onClick={p.onToggleRail} title="alternar rail (⌘B)">
            <Icon name="rail" />
          </IconButton>
        )}
        {!p.focus && (
          <IconButton label="Dock" active={p.dockOpen} onClick={p.onToggleDock} title="alternar dock (⌘J)">
            <Icon name="dock" />
          </IconButton>
        )}
        <IconButton label="Foco" active={p.focus} onClick={p.onToggleFocus} title="modo foco (⌘.)">
          <Icon name="focus" />
        </IconButton>
        <IconButton label="Configurações" onClick={p.onOpenSettings} title="configurações (⌘,)">
          <Icon name="settings" />
        </IconButton>
      </div>

      {/* reconexão: barra indeterminada fina na base da topbar */}
      {connecting && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-px overflow-hidden">
          <span
            className="block h-full w-1/3 bg-[linear-gradient(90deg,transparent,var(--color-space),transparent)]"
            style={{ animation: 'hc-kf-indeterminate 1.3s var(--hc-ease-std) infinite' }}
          />
        </span>
      )}
    </header>
  )
}
