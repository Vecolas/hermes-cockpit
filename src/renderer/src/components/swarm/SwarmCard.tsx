import { useMemo } from 'react'
import { fmtDuration, isActive, runElapsedMs, runHandle, STATUS_LABEL, useNow, useSwarm } from '../../lib/swarm'
import type { WidgetProps } from '../panels/widgets'
import { RunBar, SwarmGate } from './ui'

// Card 'Execuções do swarm' do registry (strip/dock): resumo ao vivo das runs.
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).
// O store do swarm faz o próprio polling + swarm:changed; refreshMs não é usado.
export function SwarmCard(props: WidgetProps) {
  void props.refreshMs
  const s = useSwarm()
  const anyActive = s.runs.some((r) => isActive(r.status))
  const now = useNow(1000, anyActive)

  const rows = useMemo(() => {
    const act = s.runs.filter((r) => isActive(r.status))
    const rest = s.runs.filter((r) => !isActive(r.status))
    return [...act, ...rest].slice(0, 6)
  }, [s.runs])

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col px-4 py-3">
      <header className="mb-2 flex items-baseline gap-2">
        <h3 className="truncate text-[12px] font-semibold text-ink">Execuções do swarm</h3>
        {s.approvals.length > 0 && (
          <span className="hc-fade-in rounded border border-dashed border-amber/70 px-1.5 text-[10px] text-amber">
            ! {s.approvals.length} aprovaç{s.approvals.length > 1 ? 'ões' : 'ão'}
          </span>
        )}
        {s.error && s.phase === 'ready' && (
          <span className="max-w-[40%] truncate text-[10px] text-alert" title={s.error}>
            erro: {s.error}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-faint">claude code</span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SwarmGate s={s} compact>
          {!rows.length ? (
            <div className="text-[11px] text-faint">nenhuma run</div>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="hc-rise grid grid-cols-[minmax(0,6.5rem)_1fr_auto] items-center gap-3 text-[11px]"
                  title={`${r.title || r.task} — ${STATUS_LABEL[r.status]}`}
                >
                  <span className="truncate text-dim">{runHandle(r)}</span>
                  <RunBar status={r.status} />
                  <span className="tabular-nums text-faint">[{fmtDuration(runElapsedMs(r, now))}]</span>
                </li>
              ))}
            </ul>
          )}
        </SwarmGate>
      </div>
    </section>
  )
}
