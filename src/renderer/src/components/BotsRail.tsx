import { GROUP_LABELS, GROUP_ORDER, botTitle, type BotProfile } from '../lib/bots'
import { ErrorBoundary } from './ErrorBoundary'
import { ProviderRow } from './panels/widgets'
import { usePluginSource } from './panels/source'
import { API, type Quota } from './panels/types'

interface Props {
  bots: BotProfile[]
  selected: string | null
  onSelect: (name: string) => void
  loading: boolean
  /** mensagem quando profiles.list e /bots falharam */
  error?: string | null
}

// Rail de bots como no wireframe: seções por grupo, item ativo com borda e
// losango âmbar, "rodando" em verde, contador de sessões; rodapé com cota por
// provedor (/quota do plugin). SWARM CODERS fica fora até existir fonte real
// de subagents (P2-15) — sem chips inventados.
export function BotsRail({ bots, selected, onSelect, loading, error }: Props) {
  const byGroup = new Map<string, BotProfile[]>()
  for (const bot of bots) {
    const arr = byGroup.get(bot.group) ?? []
    arr.push(bot)
    byGroup.set(bot.group, arr)
  }

  return (
    <aside className="flex h-full min-w-0 flex-col bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-2">
        {loading && bots.length === 0 && <div className="px-1 py-1 text-[11px] text-dim">conectando…</div>}
        {!loading && bots.length === 0 && (
          <div className="px-1 py-1 text-[11px] text-faint">{error ?? 'nenhum profile retornado'}</div>
        )}
        {GROUP_ORDER.map((group) => {
          const items = byGroup.get(group)
          if (!items?.length) return null
          return (
            <div key={group} className="mb-4">
              <div className="label px-1 pb-1.5">{GROUP_LABELS[group] ?? group}</div>
              <div className="space-y-0.5">
                {items.map((bot) => (
                  <BotItem key={bot.name} bot={bot} active={bot.name === selected} onSelect={onSelect} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <ErrorBoundary label="Cota" compact className="border-t border-edge py-2">
        <QuotaFooter />
      </ErrorBoundary>
    </aside>
  )
}

function BotItem({ bot, active, onSelect }: { bot: BotProfile; active: boolean; onSelect: (n: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(bot.name)}
      title={[bot.descricao, bot.modelo && `modelo: ${bot.modelo}`].filter(Boolean).join('\n') || undefined}
      className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
        active
          ? 'border-amber/80 bg-panel2 text-ink'
          : 'border-transparent text-dim hover:bg-panel2/60 hover:text-ink'
      }`}
    >
      {active ? (
        <span className="h-2 w-2 shrink-0 rotate-45 bg-amber glow-amber" aria-hidden />
      ) : bot.rodando ? (
        <span className="h-2 w-2 shrink-0 rounded-full bg-phos glow-phos" aria-hidden />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-full border border-faint" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{botTitle(bot.name)}</span>
      {bot.rodando && <span className="shrink-0 text-[10px] text-phos">rodando</span>}
      {bot.sessoes != null && (
        <span className="shrink-0 text-[10px] text-faint" title="sessões">
          {bot.sessoes}
        </span>
      )}
    </button>
  )
}

function QuotaFooter() {
  const quota = usePluginSource<Quota>(API.quota, 60_000)
  const provs = quota.data?.provedores ?? []
  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-edge px-3 py-2.5">
      <div className="label mb-1.5 flex items-center gap-2">
        <span>Provedores · cota</span>
        {quota.error && (
          <span className="truncate normal-case tracking-normal text-alert" title={quota.error}>
            erro
          </span>
        )}
      </div>
      {quota.loading && <div className="text-[10px] text-faint">carregando…</div>}
      {!quota.loading && provs.length === 0 && (
        <div className="text-[10px] text-faint">{quota.error ? 'cota indisponível' : 'sem provedores'}</div>
      )}
      <div className="space-y-2">
        {provs.map((p, i) => (
          <ProviderRow key={`${p.nome}-${i}`} p={p} />
        ))}
      </div>
    </div>
  )
}
