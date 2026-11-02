import { useMemo, useState } from 'react'
import { type CronJob, fmtDateTime, jobNextRuns, jobProfile, jobTitle, useNow } from '../../lib/automations'
import { cx } from '../ui'

// Timeline SVG das execuções futuras: uma faixa por bot, um marcador por
// disparo previsto (o 1º é o next_run_at oficial; os demais, projeção local).

const HORIZONS = [
  { id: '24h', label: '24 h', ms: 24 * 3600_000 },
  { id: '7d', label: '7 dias', ms: 7 * 86400_000 },
] as const

const LANE_H = 22
const PAD_L = 74
const PAD_R = 10
const AXIS_H = 18

export function CronTimeline({ jobs, selectedId, onSelect }: { jobs: CronJob[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [hz, setHz] = useState<(typeof HORIZONS)[number]['id']>('24h')
  const now = useNow()
  const minuteNow = Math.floor(now / 60_000) * 60_000
  const horizon = HORIZONS.find((h) => h.id === hz)!.ms
  const W = 1000

  const lanes = useMemo(() => {
    const by = new Map<string, { job: CronJob; at: Date }[]>()
    const from = new Date(minuteNow)
    const end = minuteNow + horizon
    for (const j of jobs) {
      const runs = jobNextRuns(j, hz === '24h' ? 60 : 200, from).filter((d) => d.getTime() <= end)
      const p = jobProfile(j)
      if (!by.has(p)) by.set(p, [])
      for (const at of runs) by.get(p)!.push({ job: j, at })
    }
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    // minuteNow muda 1x/min: recalcula sem custo por segundo
  }, [jobs, minuteNow, horizon, hz])

  const total = lanes.reduce((n, [, r]) => n + r.length, 0)
  const H = AXIS_H + Math.max(1, lanes.length) * LANE_H + 6
  const x = (t: number) => PAD_L + ((t - now) / horizon) * (W - PAD_L - PAD_R)

  // marcas do eixo: a cada 3h (24h) ou meia-noite (7d)
  const ticks: { t: number; label: string; major: boolean }[] = []
  if (hz === '24h') {
    const d = new Date(now)
    d.setMinutes(0, 0, 0)
    d.setHours(d.getHours() + 1)
    for (let t = d.getTime(); t <= now + horizon; t += 3600_000) {
      const h = new Date(t).getHours()
      if (h % 3 === 0) ticks.push({ t, label: `${String(h).padStart(2, '0')}h`, major: h === 0 })
    }
  } else {
    const d = new Date(now)
    d.setHours(24, 0, 0, 0)
    for (let t = d.getTime(); t <= now + horizon; t += 86400_000) {
      const dd = new Date(t)
      ticks.push({ t, label: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][dd.getDay()] + ` ${dd.getDate()}`, major: true })
    }
  }

  return (
    <div className="hc-card rounded-lg border border-edge bg-panel/70 p-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="label">Próximas execuções</span>
        <span className="text-[10.5px] tabular-nums text-faint">{total} disparos previstos</span>
        <div className="ml-auto flex gap-0.5 rounded-md border border-edge p-0.5">
          {HORIZONS.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => setHz(h.id)}
              className={cx(
                'rounded px-1.5 py-px text-[10px] uppercase tracking-[0.12em] transition-colors',
                hz === h.id ? 'bg-amber/15 text-amber' : 'text-faint hover:text-dim',
              )}
            >
              {h.label}
            </button>
          ))}
        </div>
      </div>
      {lanes.length === 0 ? (
        <div className="py-3 text-center text-[11px] text-faint">nenhum disparo previsto nesta janela (jobs pausados não aparecem)</div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="timeline de execuções futuras">
          <defs>
            <linearGradient id="hc-tl-now" x1="0" x2="1">
              <stop offset="0" stopColor="var(--color-phos)" stopOpacity="0" />
              <stop offset="1" stopColor="var(--color-phos)" stopOpacity="0.18" />
            </linearGradient>
          </defs>
          {ticks.map((tk) => (
            <g key={tk.t}>
              <line x1={x(tk.t)} x2={x(tk.t)} y1={AXIS_H - 4} y2={H} stroke="var(--color-edge)" strokeDasharray={tk.major ? undefined : '2 3'} />
              <text x={x(tk.t)} y={10} textAnchor="middle" fontSize="9" fill="var(--color-faint)" fontFamily="var(--font-mono)">
                {tk.label}
              </text>
            </g>
          ))}
          {lanes.map(([bot, runs], li) => {
            const y = AXIS_H + li * LANE_H + LANE_H / 2
            return (
              <g key={bot}>
                <text x={6} y={y + 3} fontSize="10" fill="var(--color-dim)" fontFamily="var(--font-mono)" style={{ textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                  {bot}
                </text>
                <line x1={PAD_L} x2={W - PAD_R} y1={y} y2={y} stroke="var(--color-edge2)" strokeOpacity="0.6" />
                {runs.map(({ job, at }, i) => {
                  const cx_ = x(at.getTime())
                  const sel = job.id === selectedId
                  const official = i === runs.findIndex((r) => r.job.id === job.id)
                  return (
                    <g key={`${job.id}-${at.getTime()}`} className="cursor-pointer" onClick={() => onSelect(job.id)}>
                      <title>{`${jobTitle(job)} · ${fmtDateTime(at)}${official ? ' (oficial)' : ' (projeção)'}`}</title>
                      <rect x={cx_ - 5} y={y - 8} width={10} height={16} fill="transparent" />
                      <line x1={cx_} x2={cx_} y1={y - (sel ? 8 : 6)} y2={y + (sel ? 8 : 6)} stroke={sel ? 'var(--color-amber)' : 'var(--color-cyanic)'} strokeWidth={sel ? 2.5 : 1.6} strokeLinecap="round" opacity={official ? 1 : 0.65} />
                      {official && <circle cx={cx_} cy={y} r={sel ? 3.2 : 2.4} fill={sel ? 'var(--color-amber)' : 'var(--color-cyanic)'} />}
                    </g>
                  )
                })}
              </g>
            )
          })}
          {/* agora */}
          <rect x={PAD_L - 24} y={AXIS_H - 4} width={24} height={H - AXIS_H + 4} fill="url(#hc-tl-now)" />
          <line x1={PAD_L} x2={PAD_L} y1={AXIS_H - 6} y2={H} stroke="var(--color-phos)" strokeWidth="1.2" />
          <text x={PAD_L + 3} y={AXIS_H - 7} fontSize="8.5" fill="var(--color-phos)" fontFamily="var(--font-mono)">
            AGORA
          </text>
        </svg>
      )}
    </div>
  )
}
