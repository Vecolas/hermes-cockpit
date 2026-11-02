import { useState } from 'react'
import { botTitle } from '../../lib/bots'
import { type CronJob, type DeliveryTarget, type SchedulePreset, cronApi, jobProfile, presetFromJob, presetToSchedule, restMsg } from '../../lib/automations'
import { toast } from '../../lib/toast'
import { Button } from '../ui'
import { ScheduleBuilder } from './ScheduleBuilder'
import { Field, Input, Select, TextArea } from './ui'

// Editor de cron: cria (POST /api/cron/jobs?profile=) ou edita (PUT updates).
// O bot (profile) é fixo após criar — o Hermes guarda o job no store do profile.

export function DeliverSelect({ value, onChange, targets, extra = [] }: { value: string; onChange: (v: string) => void; targets: DeliveryTarget[] | null; extra?: string[] }) {
  const ids = new Set((targets ?? []).map((t) => t.id))
  const missing = [...extra, value].filter((v, i, a) => v && !ids.has(v) && a.indexOf(v) === i)
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {(targets ?? [{ id: 'local', name: 'Local (só salvar)', home_target_set: true, home_env_var: null }]).map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
          {t.home_target_set ? '' : ` — sem canal home (${t.home_env_var ?? 'configurar'})`}
        </option>
      ))}
      {missing.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </Select>
  )
}

export function CronEditor({
  job,
  profiles,
  defaultProfile,
  targets,
  onSaved,
  onCancel,
}: {
  job: CronJob | null
  profiles: string[]
  defaultProfile: string
  targets: DeliveryTarget[] | null
  onSaved: (job: CronJob) => void
  onCancel: () => void
}) {
  const editing = Boolean(job)
  const [profile, setProfile] = useState(job ? jobProfile(job) : defaultProfile)
  const [name, setName] = useState(job?.name ?? '')
  const [prompt, setPrompt] = useState(job?.prompt ?? '')
  const [preset, setPreset] = useState<SchedulePreset>(presetFromJob(job))
  const [deliver, setDeliver] = useState(job?.deliver || `bot-chat:${job ? jobProfile(job) : defaultProfile}`)
  const [model, setModel] = useState(job?.model ?? '')
  const [workdir, setWorkdir] = useState(job?.workdir ?? '')
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const schedule = presetToSchedule(preset)
  const usesSkillOrScript = Boolean(job && !job.prompt && ((job.skills && job.skills.length) || job.script))

  const save = async () => {
    setError(null)
    if (!name.trim()) return setError('dê um nome ao cron')
    if (!prompt.trim() && !usesSkillOrScript) return setError('o prompt é obrigatório')
    if (!schedule) return setError('agenda vazia')
    setBusy(true)
    try {
      const body = {
        name: name.trim(),
        prompt: prompt,
        schedule,
        deliver: deliver || 'local',
        model: model.trim() || undefined,
        workdir: workdir.trim() || undefined,
      }
      const saved = job
        ? await cronApi.update(job.id, jobProfile(job), {
            ...body,
            // PUT: string vazia limpa o campo opcional
            model: model.trim(),
            workdir: workdir.trim(),
          })
        : await cronApi.create(profile, { ...body, ...(paused ? { paused: true } : {}) })
      toast({ title: editing ? 'Cron atualizado' : 'Cron criado', detail: `${saved.name || saved.id} · ${botTitle(saved.profile || profile)}`, tone: 'ok' })
      onSaved(saved)
    } catch (e) {
      setError(restMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hc-rise space-y-3 p-4">
      <div className="flex items-center gap-2">
        <span className="label text-amber">{editing ? 'Editar cron' : 'Novo cron'}</span>
        {editing && <code className="text-[10.5px] text-faint">{job!.id}</code>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Bot" hint={editing ? 'o bot não muda depois de criado' : 'o job roda com o profile deste bot'}>
          <Select
            value={profile}
            disabled={editing}
            onChange={(e) => {
              const p = e.target.value
              if (deliver === `bot-chat:${profile}`) setDeliver(`bot-chat:${p}`)
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
        <Field label="Nome">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: briefing da manhã" autoFocus={!editing} />
        </Field>
      </div>
      <Field label="Prompt" hint={usesSkillOrScript ? 'este job usa skill/script; o prompt é opcional' : 'o que o bot deve fazer a cada disparo'}>
        <TextArea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Resuma minha agenda de hoje e os e-mails urgentes…" />
      </Field>
      <div>
        <span className="label mb-1 block">Agenda</span>
        <ScheduleBuilder value={preset} onChange={setPreset} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Entrega" hint="para onde vai o resultado">
          <DeliverSelect value={deliver} onChange={setDeliver} targets={targets} />
        </Field>
        <Field label="Modelo (opcional)" hint="vazio = modelo do bot">
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={job?.model_snapshot ?? 'padrão do profile'} spellCheck={false} />
        </Field>
      </div>
      <Field label="Diretório de trabalho (opcional)">
        <Input value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/Users/…/projeto" spellCheck={false} />
      </Field>
      {!editing && (
        <label className="flex items-center gap-2 text-[11.5px] text-dim">
          <input type="checkbox" checked={paused} onChange={(e) => setPaused(e.target.checked)} className="accent-amber" />
          criar pausado (não dispara até retomar)
        </label>
      )}
      {error && <div className="hc-fade-in rounded-md border border-alert/40 bg-alert/10 px-2.5 py-1.5 text-[11.5px] text-alert">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          cancelar
        </Button>
        <Button variant="primary" size="sm" onClick={save} loading={busy}>
          {editing ? 'salvar' : 'criar cron'}
        </Button>
      </div>
    </div>
  )
}
