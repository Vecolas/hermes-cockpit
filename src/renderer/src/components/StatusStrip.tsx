import { useEffect, useState } from 'react'
import { cockpitApi, type Connection } from '../lib/connection'

// Painéis do plugin cockpit (~/.hermes/plugins/cockpit): falha de qualquer
// fonte vira chip de erro — nunca derruba a strip (contrato do plugin).

interface Foco {
  janela?: string
  proximo_evento?: { summary?: string; start?: string } | null
  blocos_livres?: Array<{ minutos?: number }>
  top3_hoje?: Array<{ task?: string }>
  erros?: Record<string, string>
}

interface Quota {
  gasto_brl?: number
  budget_brl?: number
  mes?: string
}

interface Inbox {
  responder?: unknown[]
  ler?: unknown[]
  error?: string
}

const POLL_MS = 60_000

export function StatusStrip({ conn }: { conn: Connection | null }) {
  const [foco, setFoco] = useState<Foco | null>(null)
  const [quota, setQuota] = useState<Quota | null>(null)
  const [inbox, setInbox] = useState<Inbox | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!conn) return
    let alive = true
    const tick = async () => {
      try {
        const [f, q, i] = await Promise.allSettled([
          cockpitApi<Foco>(conn, '/api/plugins/cockpit/foco'),
          cockpitApi<Quota>(conn, '/api/plugins/cockpit/quota'),
          cockpitApi<Inbox>(conn, '/api/plugins/cockpit/inbox'),
        ])
        if (!alive) return
        if (f.status === 'fulfilled') setFoco(f.value)
        if (q.status === 'fulfilled') setQuota(q.value)
        if (i.status === 'fulfilled') setInbox(i.value)
        const failed = [f, q, i].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
        setErr(failed ? String(failed.reason).slice(0, 80) : null)
      } catch (e) {
        if (alive) setErr(String(e).slice(0, 80))
      }
    }
    void tick()
    const id = setInterval(tick, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [conn])

  const livre = foco?.blocos_livres?.reduce((acc, b) => acc + (b.minutos ?? 0), 0)
  const quotaPct = quota?.gasto_brl && quota?.budget_brl ? Math.round((quota.gasto_brl / quota.budget_brl) * 100) : null

  return (
    <footer className="grid grid-cols-4 border-t border-edge bg-panel text-[11px]">
      <Cell label="Hoje · Time-boxing">
        {foco ? (
          <>
            <span className="text-amber">{foco.janela ?? '—'}</span>
            {foco.proximo_evento?.summary && (
              <span className="truncate text-dim"> · {foco.proximo_evento.summary}</span>
            )}
          </>
        ) : (
          <span className="text-faint">…</span>
        )}
      </Cell>
      <Cell label="Foco livre">
        {livre != null ? (
          <span className="text-phos">{Math.round(livre / 60)}h livre p/ foco</span>
        ) : (
          <span className="text-faint">…</span>
        )}
      </Cell>
      <Cell label="Provedores · Cota">
        {quota?.gasto_brl != null ? (
          <span className={quotaPct && quotaPct > 80 ? 'text-alert' : 'text-ink'}>
            R$ {quota.gasto_brl.toFixed(0)} / R$ {quota.budget_brl?.toFixed(0)}
            {quotaPct != null && <span className="text-faint"> · {quotaPct}%</span>}
          </span>
        ) : (
          <span className="text-faint">…</span>
        )}
      </Cell>
      <Cell label="Inbox triada">
        {inbox ? (
          inbox.error ? (
            <span className="text-faint">{inbox.error}</span>
          ) : (
            <span className="text-dim">
              <span className="text-amber">{inbox.responder?.length ?? 0}</span> responder ·{' '}
              {inbox.ler?.length ?? 0} ler
            </span>
          )
        ) : (
          <span className="text-faint">…</span>
        )}
      </Cell>
      {err && (
        <div className="col-span-4 border-t border-edge px-4 py-1 text-[10px] text-alert">
          cockpit api: {err}
        </div>
      )}
    </footer>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-r border-edge px-4 py-2 last:border-r-0">
      <span className="label">{label}</span>
      <span className="truncate">{children}</span>
    </div>
  )
}
