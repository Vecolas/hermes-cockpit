import { useMemo } from 'react'
import { type SchedulePreset, describeScheduleString, fmtDateTime, fmtCountdown, presetToSchedule, previewRuns, useNow } from '../../lib/automations'
import { cx } from '../ui'
import { Input, Select } from './ui'

// Construtor visual de agenda: presets (diário, dias úteis, semanal, de hora em
// hora, intervalo) + campo cron cru, com frase PT-BR e as próximas 5 execuções.

const KINDS: { id: SchedulePreset['kind']; label: string }[] = [
  { id: 'daily', label: 'Diário' },
  { id: 'weekdays', label: 'Dias úteis' },
  { id: 'weekly', label: 'Semanal' },
  { id: 'hourly', label: 'Horário' },
  { id: 'interval', label: 'Intervalo' },
  { id: 'raw', label: 'Cron' },
]

const DAYS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']
const DAY_TITLES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

function timeOf(p: SchedulePreset): string {
  return 'time' in p ? p.time : '09:00'
}

export function switchPreset(cur: SchedulePreset, kind: SchedulePreset['kind']): SchedulePreset {
  const time = timeOf(cur)
  switch (kind) {
    case 'daily':
      return { kind, time }
    case 'weekdays':
      return { kind, time }
    case 'weekly':
      return { kind, time, days: cur.kind === 'weekly' ? cur.days : [1] }
    case 'hourly':
      return { kind, minute: cur.kind === 'hourly' ? cur.minute : 0 }
    case 'interval':
      return cur.kind === 'interval' ? cur : { kind, every: 30, unit: 'm' }
    case 'raw':
      return { kind, expr: presetToSchedule(cur) }
  }
}

export function ScheduleBuilder({ value, onChange }: { value: SchedulePreset; onChange: (p: SchedulePreset) => void }) {
  const schedule = presetToSchedule(value)
  const now = useNow()
  const minute = Math.floor(now / 60_000)
  const preview = useMemo(() => previewRuns(schedule, 5, new Date(minute * 60_000)), [schedule, minute])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            onClick={() => onChange(switchPreset(value, k.id))}
            className={cx(
              'rounded-md border px-2 py-1 text-[10.5px] uppercase tracking-[0.12em] transition-colors',
              value.kind === k.id ? 'border-amber/60 bg-amber/10 text-amber' : 'border-edge2 text-dim hover:border-faint hover:text-ink',
            )}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-dim">
        {(value.kind === 'daily' || value.kind === 'weekdays' || value.kind === 'weekly') && (
          <>
            <span>às</span>
            <Input type="time" value={value.time} onChange={(e) => onChange({ ...value, time: e.target.value || '09:00' })} className="w-[110px]" />
          </>
        )}
        {value.kind === 'weekly' && (
          <div className="flex gap-0.5">
            {DAYS.map((d, i) => {
              const on = value.days.includes(i)
              return (
                <button
                  key={i}
                  type="button"
                  title={DAY_TITLES[i]}
                  onClick={() => onChange({ ...value, days: on ? value.days.filter((x) => x !== i) : [...value.days, i] })}
                  className={cx(
                    'h-7 w-7 rounded-md border text-[11px] transition-colors',
                    on ? 'border-cyanic/60 bg-cyanic/15 text-cyanic' : 'border-edge2 text-faint hover:text-ink',
                  )}
                >
                  {d}
                </button>
              )
            })}
          </div>
        )}
        {value.kind === 'hourly' && (
          <>
            <span>toda hora, no minuto</span>
            <Input type="number" min={0} max={59} value={value.minute} onChange={(e) => onChange({ ...value, minute: Number(e.target.value) || 0 })} className="w-[72px]" />
          </>
        )}
        {value.kind === 'interval' && (
          <>
            <span>a cada</span>
            <Input type="number" min={1} value={value.every} onChange={(e) => onChange({ ...value, every: Math.max(1, Number(e.target.value) || 1) })} className="w-[80px]" />
            <Select value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value === 'h' ? 'h' : 'm' })} className="w-[96px]">
              <option value="m">minutos</option>
              <option value="h">horas</option>
            </Select>
          </>
        )}
        {value.kind === 'raw' && (
          <Input
            value={value.expr}
            onChange={(e) => onChange({ ...value, expr: e.target.value })}
            placeholder="0 9 * * 1-5  ·  every 2h  ·  2026-12-24T18:00"
            spellCheck={false}
            className="flex-1 font-mono"
          />
        )}
      </div>

      <div className="rounded-md border border-edge bg-void/50 px-2.5 py-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] text-ink">{preview.error ? '—' : describeScheduleString(schedule)}</span>
          <code className="ml-auto text-[10.5px] text-faint">{schedule || '∅'}</code>
        </div>
        {preview.error ? (
          <div className="mt-1 text-[11px] text-alert">{preview.error}</div>
        ) : (
          <ol className="hc-stagger mt-1.5 grid gap-0.5">
            {preview.runs.map((d, i) => (
              <li key={d.getTime()} className="hc-fade-in flex items-center gap-2 text-[11px]">
                <span className="w-3 text-right tabular-nums text-faint">{i + 1}</span>
                <span className="tabular-nums text-dim">{fmtDateTime(d)}</span>
                <span className="ml-auto tabular-nums text-faint">em {fmtCountdown(d.getTime() - now)}</span>
              </li>
            ))}
            {!preview.runs.length && <li className="text-[11px] text-faint">nenhuma execução futura</li>}
          </ol>
        )}
        <div className="mt-1 text-[10px] text-faint">preview no horário local; o Hermes valida e calcula o oficial ao salvar</div>
      </div>
    </div>
  )
}
