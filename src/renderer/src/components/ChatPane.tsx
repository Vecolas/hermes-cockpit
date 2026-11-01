import type { ConnState } from '../lib/rpc'

interface Props {
  bot: string | null
  connState: ConnState
  wsUrl: string | null
}

// Placeholder do chat: a conexão já está de pé (verde no header); o streaming
// de prompt (prompt.* + eventos de turno) é a próxima etapa do MVP.
export function ChatPane({ bot, connState, wsUrl }: Props) {
  return (
    <section className="relative flex h-full flex-col bg-void scanlines">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="font-display text-base capitalize">{bot ?? '—'}</span>
          <span className="label">Chief of Staff</span>
        </div>
        <ConnBadge state={connState} />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="font-display text-4xl tracking-wide text-ink/90">HERMES COCKPIT</div>
        <p className="max-w-md text-dim">
          Backend conectado. O rail à esquerda já lê seus profiles ao vivo; os painéis abaixo já
          puxam do plugin cockpit.
        </p>
        {wsUrl && (
          <code className="rounded border border-edge bg-panel px-3 py-1.5 text-[11px] text-faint">
            {wsUrl.replace(/token=.*/, 'token=•••')}
          </code>
        )}
        <div className="rounded-md border border-amber/30 bg-amber/5 px-4 py-2 text-[12px] text-amber">
          próxima etapa: streaming do chat (prompt.* + eventos de turno)
        </div>
      </div>

      <div className="border-t border-edge px-5 py-3">
        <div className="flex items-center gap-3 rounded-lg border border-edge bg-panel px-4 py-2.5 text-faint">
          <span className="text-amber">+</span>
          <input
            disabled
            placeholder="O que vamos atacar? (composer ativa na etapa de chat)"
            className="flex-1 bg-transparent text-ink placeholder:text-faint focus:outline-none disabled:cursor-not-allowed"
          />
          <kbd className="rounded border border-edge2 px-1.5 py-0.5 text-[10px] text-faint">⏎</kbd>
        </div>
      </div>
    </section>
  )
}

function ConnBadge({ state }: { state: ConnState }) {
  const map: Record<ConnState, { label: string; cls: string }> = {
    idle: { label: 'ocioso', cls: 'text-faint' },
    connecting: { label: 'conectando', cls: 'text-amber' },
    open: { label: 'ws aberto', cls: 'text-phos glow-phos' },
    closed: { label: 'fechado', cls: 'text-faint' },
    error: { label: 'erro', cls: 'text-alert' },
  }
  const { label, cls } = map[state]
  return (
    <span className={`flex items-center gap-2 text-[11px] ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}
