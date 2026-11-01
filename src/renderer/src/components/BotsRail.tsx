import { GROUP_LABELS, GROUP_ORDER, type BotProfile } from '../lib/bots'

interface Props {
  bots: BotProfile[]
  selected: string | null
  onSelect: (name: string) => void
  loading: boolean
}

export function BotsRail({ bots, selected, onSelect, loading }: Props) {
  const byGroup = new Map<string, BotProfile[]>()
  for (const bot of bots) {
    const arr = byGroup.get(bot.group) ?? []
    arr.push(bot)
    byGroup.set(bot.group, arr)
  }

  return (
    <aside className="flex h-full flex-col border-r border-edge bg-panel">
      <div className="border-b border-edge px-4 py-3">
        <div className="label">Hermes · Cockpit</div>
        <div className="font-display mt-1 text-lg text-ink">Esquadrão</div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {loading && <div className="px-2 py-1 text-dim">conectando…</div>}
        {!loading && bots.length === 0 && (
          <div className="px-2 py-1 text-faint">nenhum profile retornado</div>
        )}
        {GROUP_ORDER.map((group) => {
          const items = byGroup.get(group)
          if (!items?.length) return null
          return (
            <div key={group} className="mb-4">
              <div className="label px-2 pb-1.5">{GROUP_LABELS[group]}</div>
              {items.map((bot) => {
                const active = bot.name === selected
                return (
                  <button
                    key={bot.name}
                    onClick={() => onSelect(bot.name)}
                    className={`group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${
                      active ? 'bg-panel2 text-ink' : 'text-dim hover:bg-panel2/60 hover:text-ink'
                    }`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        bot.rodando ? 'bg-phos glow-phos' : active ? 'bg-amber glow-amber' : 'bg-faint'
                      }`}
                    />
                    <span className="flex-1 truncate capitalize">{bot.name}</span>
                    {bot.sessoes !== undefined && (
                      <span className="text-[10px] text-faint">{bot.sessoes}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>

      <div className="border-t border-edge px-4 py-2.5 text-[10px] text-faint">
        profiles via <span className="text-dim">profiles.list</span>
      </div>
    </aside>
  )
}
