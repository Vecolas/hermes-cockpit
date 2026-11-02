import { useMemo, useState } from 'react'
import { botTitle } from '../../lib/bots'
import { type Blueprint, type BlueprintField, type CronJob, type DeliveryTarget, cronApi, jobSpace, knownProfiles, restMsg, usePolled } from '../../lib/automations'
import { inSpace, useSpace } from '../../lib/space'
import { toast } from '../../lib/toast'
import { Button, EmptyState, Skeleton, cx } from '../ui'
import { Card, Field, Input, Select, TextArea } from './ui'

// Galeria de blueprints do Hermes (cron/blueprint_catalog.py): cada um vira um
// cron real via POST /api/cron/blueprints/instantiate?profile=<bot>.

const CATEGORY_LABEL: Record<string, string> = {
  daily: 'Diário',
  email: 'E-mail',
  monitor: 'Monitor',
  dev: 'Dev',
  research: 'Pesquisa',
  weekly: 'Semanal',
  productivity: 'Produtividade',
  finance: 'Finanças',
  health: 'Saúde',
}

export function BlueprintsTab({ targets, active, onCreated }: { targets: DeliveryTarget[] | null; active: boolean; onCreated: (job: CronJob) => void }) {
  const [state] = usePolled(() => cronApi.blueprints(), 0, active)
  const [cat, setCat] = useState<string | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const list = state.phase === 'ready' ? state.data.blueprints : state.phase === 'error' ? (state.data?.blueprints ?? []) : []
  const cats = useMemo(() => [...new Set(list.map((b) => b.category))], [list])
  const shown = list.filter(
    (b) => (!cat || b.category === cat) && (!q.trim() || `${b.title} ${b.description} ${b.tags.join(' ')}`.toLowerCase().includes(q.trim().toLowerCase())),
  )
  const selected = list.find((b) => b.key === sel) ?? null

  return (
    <div className="flex h-full min-h-0">
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="label mr-1">Blueprints</span>
          <button type="button" onClick={() => setCat(null)} className={chip(!cat)}>
            todos
          </button>
          {cats.map((c) => (
            <button key={c} type="button" onClick={() => setCat(cat === c ? null : c)} className={chip(cat === c)}>
              {CATEGORY_LABEL[c] ?? c}
            </button>
          ))}
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="buscar…" className="ml-auto w-[180px] py-1" />
        </div>
        {state.phase === 'error' && <EmptyState tone="error" title="Blueprints indisponíveis" detail={state.error} />}
        {state.phase === 'loading' && (
          <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        )}
        <div className="hc-stagger grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
          {shown.map((b) => (
            <Card
              key={b.key}
              role="button"
              tabIndex={0}
              onClick={() => setSel(b.key)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setSel(b.key)}
              className={cx('hc-card-hover hc-press cursor-pointer p-3 transition-colors', sel === b.key ? 'hc-edge-active border-amber/50' : 'hover:border-edge2')}
            >
              <div className="flex items-center gap-2">
                <span className="text-[9.5px] uppercase tracking-[0.16em] text-amber/80">{CATEGORY_LABEL[b.category] ?? b.category}</span>
                {b.scheduleHuman && <span className="ml-auto truncate text-[10px] text-faint">{b.scheduleHuman}</span>}
              </div>
              <div className="mt-1 text-[13px] text-ink">{b.title}</div>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-dim">{b.description}</p>
            </Card>
          ))}
        </div>
        {state.phase === 'ready' && !shown.length && <EmptyState compact title="Nenhum blueprint com esse filtro" />}
      </section>
      {selected && (
        <aside className="hc-slide-left w-[380px] shrink-0 overflow-y-auto border-l border-edge bg-panel/40">
          <BlueprintForm key={selected.key} bp={selected} targets={targets} onClose={() => setSel(null)} onCreated={onCreated} />
        </aside>
      )}
    </div>
  )
}

function chip(on: boolean): string {
  return cx(
    'rounded border px-1.5 py-px text-[10px] uppercase tracking-[0.12em] transition-colors',
    on ? 'border-amber/50 bg-amber/10 text-amber' : 'border-edge2 text-faint hover:text-dim',
  )
}

function BlueprintForm({ bp, targets, onClose, onCreated }: { bp: Blueprint; targets: DeliveryTarget[] | null; onClose: () => void; onCreated: (job: CronJob) => void }) {
  const space = useSpace()
  const profiles = knownProfiles().filter((p) => inSpace(jobSpace({ id: '', enabled: true, profile: p }), space))
  const [profile, setProfile] = useState(profiles.includes('chief') ? 'chief' : (profiles[0] ?? 'default'))
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {}
    for (const f of bp.fields) if (f.default != null) v[f.name] = f.default
    // entrega padrão no Bot Chat do bot (em vez de "origin", que no dashboard cai no home)
    const deliver = bp.fields.find((f) => f.name === 'deliver')
    if (deliver && (v.deliver === 'origin' || !v.deliver) && deliver.options.includes(`bot-chat:${profile}`)) v.deliver = `bot-chat:${profile}`
    return v
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setVal = (k: string, val: string) => setValues((p) => ({ ...p, [k]: val }))

  const submit = async () => {
    setError(null)
    const missing = bp.fields.filter((f) => !f.optional && !(values[f.name] ?? '').trim())
    if (missing.length) return setError(`preencha: ${missing.map((f) => f.label).join(', ')}`)
    setBusy(true)
    try {
      const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''))
      const job = await cronApi.instantiate(profile, bp.key, clean)
      toast({ title: 'Blueprint instanciado', detail: `${bp.title} · ${botTitle(profile)}`, tone: 'ok' })
      onCreated(job)
    } catch (e) {
      setError(restMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="label text-amber">Instanciar</div>
          <h3 className="mt-1 font-display text-[17px] leading-tight text-ink">{bp.title}</h3>
          <p className="mt-1 text-[11.5px] leading-snug text-dim">{bp.description}</p>
        </div>
        <button type="button" onClick={onClose} className="text-faint hover:text-ink" aria-label="fechar">
          ✕
        </button>
      </div>
      <Field label="Bot" hint="o cron roda neste profile">
        <Select
          value={profile}
          onChange={(e) => {
            const p = e.target.value
            if (values.deliver === `bot-chat:${profile}`) setVal('deliver', `bot-chat:${p}`)
            setProfile(p)
          }}
        >
          {profiles.map((p) => (
            <option key={p} value={p}>
              {p === 'default' ? 'default (Hermes)' : `${p} — ${botTitle(p)}`}
            </option>
          ))}
        </Select>
      </Field>
      {bp.fields.map((f) => (
        <Field key={f.name} label={`${f.label}${f.optional ? ' (opcional)' : ''}`} hint={f.name === 'deliver' ? deliverHint(values.deliver, targets) : f.help}>
          <BlueprintInput field={f} value={values[f.name] ?? ''} onChange={(v) => setVal(f.name, v)} targets={targets} />
        </Field>
      ))}
      {bp.command && (
        <div className="rounded-md border border-edge bg-void/50 px-2 py-1.5">
          <div className="label mb-0.5">Equivalente no chat</div>
          <code className="block break-all text-[10.5px] text-faint">{bp.command}</code>
        </div>
      )}
      {error && <div className="hc-fade-in rounded-md border border-alert/40 bg-alert/10 px-2.5 py-1.5 text-[11.5px] text-alert">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          cancelar
        </Button>
        <Button size="sm" variant="primary" onClick={submit} loading={busy}>
          criar cron
        </Button>
      </div>
    </div>
  )
}

function deliverHint(v: string | undefined, targets: DeliveryTarget[] | null): string {
  if (v === 'origin') return 'origin = canal home configurado do Hermes'
  if (v === 'local') return 'só salva o resultado, sem mensagem'
  const t = targets?.find((x) => x.id === v)
  if (t && !t.home_target_set) return `${t.name} sem canal home — defina ${t.home_env_var ?? 'o canal'} no Hermes`
  return 'para onde vai o resultado (Telegram, Slack, Bot Chat…)'
}

function optionLabel(o: string, targets: DeliveryTarget[] | null, isDeliver: boolean): string {
  if (!isDeliver) return o
  if (o === 'origin') return 'origin (canal home)'
  return targets?.find((t) => t.id === o)?.name ?? o
}

function BlueprintInput({ field, value, onChange, targets }: { field: BlueprintField; value: string; onChange: (v: string) => void; targets: DeliveryTarget[] | null }) {
  const isDeliver = field.name === 'deliver'
  if (field.type === 'time') return <Input type="time" value={value} onChange={(e) => onChange(e.target.value)} />
  if ((field.type === 'enum' || field.type === 'weekdays') && field.options.length) {
    if (field.strict === false && !isDeliver) {
      const id = `bp-${field.name}`
      return (
        <>
          <Input list={id} value={value} onChange={(e) => onChange(e.target.value)} />
          <datalist id={id}>
            {field.options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </>
      )
    }
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {field.optional && <option value="">—</option>}
        {[...new Set([...field.options, ...(value && !field.options.includes(value) ? [value] : [])])].map((o) => (
          <option key={o} value={o}>
            {optionLabel(o, targets, isDeliver)}
          </option>
        ))}
      </Select>
    )
  }
  if (field.name === 'prompt' || field.name === 'instructions' || /topic|query|focus/.test(field.name)) {
    return <TextArea rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
  }
  return <Input value={value} onChange={(e) => onChange(e.target.value)} />
}
