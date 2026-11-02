import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { botTitle } from '../../lib/bots'
import {
  type CronJob,
  type CronRun,
  type DeliveryTarget,
  type SessionMessage,
  cronApi,
  describeJobSchedule,
  fmtAgo,
  fmtDateTime,
  jobNextRuns,
  jobPaused,
  jobProfile,
  jobSpace,
  jobStatus,
  jobTitle,
  knownProfiles,
  restMsg,
} from '../../lib/automations'
import { inSpace, useSpace } from '../../lib/space'
import { toast } from '../../lib/toast'
import { Badge, Button, ConfirmButton, EmptyState, SkeletonLines, Spinner, cx } from '../ui'
import { CronEditor } from './CronEditor'
import { CronTimeline } from './CronTimeline'
import { BotChip, Countdown, SectionTitle } from './ui'

// Crons do Hermes por bot: lista com contagem regressiva, timeline, detalhe com
// ações (pausar/retomar/rodar agora/apagar 2 cliques), histórico com saída.

export interface CronsState {
  jobs: CronJob[] | null
  error: string | null
  loading: boolean
  reload: () => Promise<void>
  targets: DeliveryTarget[] | null
}

type Pane = { kind: 'detail'; id: string } | { kind: 'new' } | { kind: 'edit'; id: string } | { kind: 'none' }

export function CronsTab({ state, focusId, onFocused }: { state: CronsState; focusId: string | null; onFocused: () => void }) {
  const space = useSpace()
  const [pane, setPane] = useState<Pane>({ kind: 'none' })
  const [botFilter, setBotFilter] = useState<string | null>(null)

  useEffect(() => {
    if (focusId) {
      setPane({ kind: 'detail', id: focusId })
      onFocused()
    }
  }, [focusId, onFocused])

  const visible = useMemo(
    () => (state.jobs ?? []).filter((j) => inSpace(jobSpace(j), space) && (!botFilter || jobProfile(j) === botFilter)),
    [state.jobs, space, botFilter],
  )
  const groups = useMemo(() => {
    const m = new Map<string, CronJob[]>()
    for (const j of visible) {
      const p = jobProfile(j)
      if (!m.has(p)) m.set(p, [])
      m.get(p)!.push(j)
    }
    const order = knownProfiles()
    return [...m.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
  }, [visible])

  const bots = useMemo(() => [...new Set((state.jobs ?? []).filter((j) => inSpace(jobSpace(j), space)).map(jobProfile))], [state.jobs, space])
  const profiles = useMemo(() => knownProfiles(bots).filter((p) => inSpace(jobSpace({ id: '', enabled: true, profile: p }), space)), [bots, space])

  const selectedId = pane.kind === 'detail' || pane.kind === 'edit' ? pane.id : null
  const selected = selectedId ? ((state.jobs ?? []).find((j) => j.id === selectedId) ?? null) : null

  // auto-seleção do 1º visível
  useEffect(() => {
    if (pane.kind === 'none' && visible.length) setPane({ kind: 'detail', id: visible[0].id })
    if ((pane.kind === 'detail' || pane.kind === 'edit') && state.jobs && !state.jobs.some((j) => j.id === pane.id)) setPane({ kind: 'none' })
  }, [pane, visible, state.jobs])

  return (
    <div className="flex h-full min-h-0">
      {/* lista */}
      <section className="flex w-[360px] shrink-0 flex-col border-r border-edge">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <span className="label">Crons</span>
          {state.jobs && <span className="text-[10.5px] tabular-nums text-faint">{visible.length}</span>}
          {state.loading && <Spinner size={10} className="text-faint" />}
          <Button size="xs" variant="primary" className="ml-auto" onClick={() => setPane({ kind: 'new' })}>
            + novo
          </Button>
        </div>
        {bots.length > 1 && (
          <div className="flex flex-wrap gap-1 border-b border-edge px-3 py-1.5">
            <FilterChip on={!botFilter} onClick={() => setBotFilter(null)}>
              todos
            </FilterChip>
            {bots.map((b) => (
              <FilterChip key={b} on={botFilter === b} onClick={() => setBotFilter(botFilter === b ? null : b)}>
                {b}
              </FilterChip>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {state.error && (
            <EmptyState compact tone="error" title="Crons indisponíveis" detail={state.error} action={<Button size="xs" variant="outline" onClick={() => void state.reload()}>tentar de novo</Button>} />
          )}
          {!state.jobs && !state.error && <SkeletonLines lines={6} />}
          {state.jobs && !visible.length && !state.error && (
            <EmptyState
              compact
              title={state.jobs.length ? 'Nenhum cron neste espaço' : 'Nenhum cron agendado'}
              detail={state.jobs.length ? 'troque o espaço para ver os demais bots' : 'crie um do zero ou instancie um blueprint'}
            />
          )}
          <div className="hc-stagger space-y-3">
            {groups.map(([bot, jobs]) => (
              <div key={bot}>
                <div className="mb-1 flex items-center gap-1.5 px-1">
                  <BotChip name={bot} />
                  <span className="truncate text-[10.5px] text-faint">{botTitle(bot)}</span>
                  <span className="ml-auto text-[10px] tabular-nums text-faint">{jobs.length}</span>
                </div>
                <div className="space-y-1">
                  {jobs.map((j) => (
                    <JobRow key={j.id} job={j} active={j.id === selectedId} onClick={() => setPane({ kind: 'detail', id: j.id })} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* detalhe / editor */}
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {state.jobs && visible.length > 0 && pane.kind !== 'new' && pane.kind !== 'edit' && (
          <div className="px-4 pt-4">
            <CronTimeline jobs={visible} selectedId={selectedId} onSelect={(id) => setPane({ kind: 'detail', id })} />
          </div>
        )}
        {pane.kind === 'new' && (
          <CronEditor
            key="new"
            job={null}
            profiles={profiles.length ? profiles : knownProfiles()}
            defaultProfile={botFilter ?? (space === 'houer' ? 'atlas' : space === 'pessoal' ? 'lar' : 'chief')}
            targets={state.targets}
            onCancel={() => setPane({ kind: 'none' })}
            onSaved={(j) => {
              void state.reload()
              setPane({ kind: 'detail', id: j.id })
            }}
          />
        )}
        {pane.kind === 'edit' && selected && (
          <CronEditor
            key={`edit-${selected.id}`}
            job={selected}
            profiles={knownProfiles([jobProfile(selected)])}
            defaultProfile={jobProfile(selected)}
            targets={state.targets}
            onCancel={() => setPane({ kind: 'detail', id: selected.id })}
            onSaved={(j) => {
              void state.reload()
              setPane({ kind: 'detail', id: j.id })
            }}
          />
        )}
        {pane.kind === 'detail' && selected && (
          <CronDetail key={selected.id} job={selected} targets={state.targets} reload={state.reload} onEdit={() => setPane({ kind: 'edit', id: selected.id })} />
        )}
        {pane.kind === 'none' && state.jobs && !visible.length && (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState title="Agende um bot" detail="Crons do Hermes rodam um prompt num bot em horário fixo e entregam o resultado no Telegram, Slack ou no Bot Chat." action={<Button size="sm" variant="primary" onClick={() => setPane({ kind: 'new' })}>novo cron</Button>} />
          </div>
        )}
      </section>
    </div>
  )
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'rounded border px-1.5 py-px text-[10px] uppercase tracking-[0.12em] transition-colors',
        on ? 'border-amber/50 bg-amber/10 text-amber' : 'border-edge2 text-faint hover:text-dim',
      )}
    >
      {children}
    </button>
  )
}

function JobRow({ job, active, onClick }: { job: CronJob; active: boolean; onClick: () => void }) {
  const st = jobStatus(job)
  const next = jobNextRuns(job, 1)[0] ?? null
  const lastBad = job.last_status === 'error' || Boolean(job.last_delivery_error)
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'hc-card hc-card-hover hc-press group relative block w-full rounded-md border px-2.5 py-2 text-left transition-colors',
        active ? 'hc-edge-active border-amber/50 bg-amber/[0.06]' : 'border-edge bg-panel/60 hover:border-edge2',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', st.tone === 'phos' ? 'bg-phos hc-pulse-dot' : st.tone === 'amber' ? 'bg-amber' : st.tone === 'alert' ? 'bg-alert' : st.tone === 'cyanic' ? 'bg-cyanic' : 'bg-faint')} />
        <span className={cx('min-w-0 flex-1 truncate text-[12px]', jobPaused(job) ? 'text-dim' : 'text-ink')}>{jobTitle(job)}</span>
        {jobPaused(job) ? <span className="text-[10px] uppercase tracking-[0.12em] text-faint">{st.label}</span> : <Countdown at={next} className="text-[10.5px]" />}
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-3.5 text-[10.5px] text-faint">
        <span className="min-w-0 flex-1 truncate">{describeJobSchedule(job)}</span>
        {job.last_run_at && (
          <span className={cx('shrink-0', lastBad ? 'text-alert' : job.last_status === 'ok' ? 'text-phos/80' : '')} title={job.last_error ?? job.last_delivery_error ?? undefined}>
            {lastBad ? '✕' : job.last_status === 'ok' ? '✓' : '·'} {fmtAgo(job.last_run_at)}
          </span>
        )}
      </div>
    </button>
  )
}

function CronDetail({ job, targets, reload, onEdit }: { job: CronJob; targets: DeliveryTarget[] | null; reload: () => Promise<void>; onEdit: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [runsTick, setRunsTick] = useState(0)
  const profile = jobProfile(job)
  const st = jobStatus(job)
  const next = jobNextRuns(job, 5)
  const target = targets?.find((t) => t.id === job.deliver)

  const act = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label)
    try {
      await fn()
      toast({ title: ok, detail: jobTitle(job), tone: 'ok' })
      await reload()
      setRunsTick((x) => x + 1)
    } catch (e) {
      toast({ title: `Falha ao ${label}`, detail: restMsg(e), tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="hc-fade-in space-y-4 p-4">
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <BotChip name={profile} />
            <Badge tone={st.tone} pulse={st.tone === 'phos'}>
              {st.label}
            </Badge>
          </div>
          <h2 className="mt-1.5 truncate font-display text-[19px] leading-tight text-ink">{jobTitle(job)}</h2>
          <div className="mt-0.5 text-[11.5px] text-dim">
            {describeJobSchedule(job)} <code className="ml-1 text-[10.5px] text-faint">{job.schedule?.expr ?? job.schedule_display}</code>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {jobPaused(job) ? (
            <Button size="xs" variant="outline" loading={busy === 'retomar'} disabled={Boolean(busy)} onClick={() => act('retomar', () => cronApi.resume(job.id, profile), 'Cron retomado')}>
              retomar
            </Button>
          ) : (
            <Button size="xs" variant="outline" loading={busy === 'pausar'} disabled={Boolean(busy)} onClick={() => act('pausar', () => cronApi.pause(job.id, profile), 'Cron pausado')}>
              pausar
            </Button>
          )}
          <Button size="xs" variant="secondary" loading={busy === 'rodar'} disabled={Boolean(busy)} onClick={() => act('rodar', () => cronApi.trigger(job.id, profile), 'Execução concluída')} title="dispara agora (a chamada espera o job terminar)">
            {busy === 'rodar' ? 'rodando…' : 'rodar agora'}
          </Button>
          <Button size="xs" variant="ghost" disabled={Boolean(busy)} onClick={onEdit}>
            editar
          </Button>
          <ConfirmButton disabled={Boolean(busy)} onConfirm={() => act('apagar', () => cronApi.remove(job.id, profile), 'Cron apagado')}>
            apagar
          </ConfirmButton>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Próxima">
          {next[0] ? (
            <>
              <Countdown at={next[0]} className="text-[13px]" />
              <div className="text-[10.5px] text-faint">{fmtDateTime(next[0])}</div>
            </>
          ) : (
            <span className="text-faint">{jobPaused(job) ? 'pausado' : '—'}</span>
          )}
        </Stat>
        <Stat label="Última">
          <span className={cx(job.last_status === 'error' ? 'text-alert' : job.last_status === 'ok' ? 'text-phos' : 'text-dim')}>{job.last_status ?? 'nunca rodou'}</span>
          <div className="text-[10.5px] text-faint">{job.last_run_at ? `${fmtDateTime(new Date(job.last_run_at))} · ${fmtAgo(job.last_run_at)}` : '—'}</div>
        </Stat>
        <Stat label="Entrega">
          <span className="truncate text-dim">{target?.name ?? job.deliver ?? 'local'}</span>
          {target && !target.home_target_set && <div className="text-[10.5px] text-amber">sem canal home ({target.home_env_var})</div>}
        </Stat>
        <Stat label="Modelo">
          <span className="truncate text-dim">{job.model ?? job.model_snapshot ?? 'padrão do bot'}</span>
          {Boolean(job.failure_streak) && <div className="text-[10.5px] text-alert">{job.failure_streak} falhas seguidas</div>}
        </Stat>
      </div>

      {(job.last_error || job.last_delivery_error || (jobPaused(job) && job.paused_reason)) && (
        <div className="space-y-1.5">
          {job.last_error && <Alert tone="alert" label="Erro da última execução" text={job.last_error} />}
          {job.last_delivery_error && <Alert tone="alert" label="Erro de entrega" text={job.last_delivery_error} />}
          {jobPaused(job) && job.paused_reason && <Alert tone="neutral" label="Pausado" text={job.paused_reason} />}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_260px]">
        <div>
          <SectionTitle>Prompt</SectionTitle>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-void/50 p-2.5 text-[11.5px] leading-relaxed text-dim">
            {job.prompt || (job.skills?.length ? `skills: ${job.skills.join(', ')}` : job.script ? `script: ${job.script}` : '—')}
          </pre>
        </div>
        <div>
          <SectionTitle>Próximas 5</SectionTitle>
          <ol className="hc-stagger space-y-0.5">
            {next.map((d, i) => (
              <li key={d.getTime()} className="hc-fade-in flex items-center gap-2 text-[11px]">
                <span className="w-3 text-right text-faint">{i + 1}</span>
                <span className="tabular-nums text-dim">{fmtDateTime(d)}</span>
                {i === 0 && <span className="text-[9.5px] uppercase tracking-[0.14em] text-phos/80">oficial</span>}
              </li>
            ))}
            {!next.length && <li className="text-[11px] text-faint">nenhuma (pausado ou concluído)</li>}
          </ol>
        </div>
      </div>

      <CronRuns job={job} tick={runsTick} />
    </div>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hc-card min-w-0 rounded-md border border-edge bg-panel/60 px-2.5 py-2">
      <div className="label mb-0.5">{label}</div>
      <div className="min-w-0 text-[12px]">{children}</div>
    </div>
  )
}

function Alert({ tone, label, text }: { tone: 'alert' | 'neutral'; label: string; text: string }) {
  return (
    <div className={cx('rounded-md border px-2.5 py-1.5 text-[11.5px]', tone === 'alert' ? 'border-alert/40 bg-alert/10 text-alert' : 'border-edge2 bg-panel2 text-dim')}>
      <span className="mr-1.5 text-[10px] uppercase tracking-[0.14em] opacity-80">{label}</span>
      <span className="whitespace-pre-wrap break-words">{text}</span>
    </div>
  )
}

// ── histórico ───────────────────────────────────────────────────────────────

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((p) => (typeof p === 'string' ? p : p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  return ''
}

function CronRuns({ job, tick }: { job: CronJob; tick: number }) {
  const profile = jobProfile(job)
  const [runs, setRuns] = useState<CronRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    cronApi
      .runs(job.id, profile, 20)
      .then((r) => alive && setRuns(r.runs ?? []))
      .catch((e) => alive && setError(restMsg(e)))
    return () => {
      alive = false
    }
  }, [job.id, profile, tick, job.last_run_at])

  return (
    <div>
      <SectionTitle right={runs && <span className="text-[10.5px] tabular-nums text-faint">{runs.length}</span>}>Histórico de execuções</SectionTitle>
      {error && <EmptyState compact tone="error" title="Histórico indisponível" detail={error} />}
      {!runs && !error && <SkeletonLines lines={3} />}
      {runs && !runs.length && <div className="py-2 text-[11px] text-faint">nenhuma execução registrada ainda</div>}
      <div className="space-y-1">
        {runs?.map((r) => (
          <RunRow key={r.id} run={r} profile={profile} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
        ))}
      </div>
    </div>
  )
}

function RunRow({ run, profile, open, onToggle }: { run: CronRun; profile: string; open: boolean; onToggle: () => void }) {
  const [msgs, setMsgs] = useState<SessionMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [full, setFull] = useState(false)
  const started = run.started_at ? new Date(run.started_at * 1000) : null
  const dur = run.started_at && run.ended_at ? Math.max(0, run.ended_at - run.started_at) : null

  useEffect(() => {
    if (!open || msgs) return
    let alive = true
    cronApi
      .messages(run.id, run.profile ?? profile)
      .then((r) => alive && setMsgs(r.messages ?? []))
      .catch((e) => alive && setError(restMsg(e)))
    return () => {
      alive = false
    }
  }, [open, msgs, run.id, run.profile, profile])

  const shown = (msgs ?? []).filter((m) => m.role === 'assistant' || m.role === 'user' || (full && m.role === 'tool'))
  const lastAssistant = [...(msgs ?? [])].reverse().find((m) => m.role === 'assistant' && textOf(m.content).trim())

  return (
    <div className={cx('rounded-md border transition-colors', open ? 'border-edge2 bg-panel/70' : 'border-edge bg-panel/40')}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px]">
        <span className={cx('h-1.5 w-1.5 rounded-full', run.is_active ? 'bg-phos hc-pulse-dot' : run.end_reason && /error|fail/i.test(run.end_reason) ? 'bg-alert' : 'bg-cyanic/70')} />
        <span className="tabular-nums text-dim">{started ? fmtDateTime(started) : run.id}</span>
        <span className="text-faint">{run.is_active ? 'rodando' : dur != null ? `${dur < 60 ? `${Math.round(dur)}s` : `${Math.round(dur / 60)} min`}` : ''}</span>
        <span className="min-w-0 flex-1 truncate text-faint">{run.preview ?? ''}</span>
        <span className="text-[10.5px] tabular-nums text-faint">{run.message_count ?? 0} msgs</span>
        <span className={cx('text-faint transition-transform', open && 'rotate-90')}>›</span>
      </button>
      {open && (
        <div className="hc-fade-in border-t border-edge px-2.5 py-2">
          {error && <div className="text-[11px] text-alert">{error}</div>}
          {!msgs && !error && <SkeletonLines lines={3} />}
          {msgs && !full && (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink/90">
              {lastAssistant ? textOf(lastAssistant.content) : 'sem resposta do bot nesta execução'}
            </pre>
          )}
          {msgs && full && (
            <div className="max-h-96 space-y-2 overflow-auto">
              {shown.map((m, i) => (
                <div key={i}>
                  <div className={cx('text-[9.5px] uppercase tracking-[0.16em]', m.role === 'assistant' ? 'text-amber/80' : m.role === 'tool' ? 'text-cyanic/80' : 'text-faint')}>
                    {m.role}
                    {m.tool_name ? ` · ${m.tool_name}` : ''}
                  </div>
                  <pre className="whitespace-pre-wrap text-[11px] leading-relaxed text-dim">{textOf(m.content).slice(0, 4000) || '—'}</pre>
                </div>
              ))}
            </div>
          )}
          {msgs && (
            <div className="mt-1.5 flex gap-2">
              <Button size="xs" variant="ghost" onClick={() => setFull((x) => !x)}>
                {full ? 'só o resultado' : 'transcript completo'}
              </Button>
              <code className="ml-auto self-center text-[10px] text-faint">{run.id}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
