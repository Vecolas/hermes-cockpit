import { useEffect, useMemo, useState } from 'react'
import { hasMain } from '../../lib/ipc'
import {
  type Flow,
  type FlowDraft,
  type FlowRunState,
  type FlowTask,
  type PermissionMode,
  flowSpace,
  flowsApi,
  fmtAgo,
  onFlowsChanged,
  restMsg,
  runFlow,
  stopFlow,
  useFlowRuns,
  usePolled,
} from '../../lib/automations'
import { type ItemSpace, getSpace, inSpace, useSpace } from '../../lib/space'
import { type RunMeta, STATUS_LABEL, STATUS_TONE, fmtDuration, isActive, isNoHandler, runElapsedMs, useSwarm } from '../../lib/swarm'
import { toast } from '../../lib/toast'
import { Button, ConfirmButton, EmptyState, SkeletonLines, cx } from '../ui'
import { Card, Field, Input, Select, TextArea } from './ui'

// Workflows do swarm salvos (~/.hermes/cockpit/flows.json via main flows:*).
// Rodar = swarm:spawn por tarefa; paralelo compartilha o groupId; sequencial
// encadeia esperando cada run chegar em "done" (falha interrompe a cadeia).

const SPACE_LABEL: Record<ItemSpace, string> = { houer: 'Houer', pessoal: 'Pessoal', shared: 'Compartilhado' }
const PERM_LABEL: Record<PermissionMode, string> = { manual: 'manual (aprovo tudo)', auto: 'auto', acceptEdits: 'aceitar edições', bypass: 'bypass (sem perguntas)' }

type Mode = { kind: 'view'; id: string } | { kind: 'edit'; id: string } | { kind: 'new' } | { kind: 'none' }

export function FlowsTab({ active }: { active: boolean }) {
  const space = useSpace()
  const [state, reload] = usePolled(() => flowsApi.list(), 0, active)
  const [mode, setMode] = useState<Mode>({ kind: 'none' })
  const runs = useFlowRuns()

  useEffect(() => onFlowsChanged(() => void reload()), [reload])

  const flows = state.phase === 'ready' ? state.data : state.phase === 'error' ? (state.data ?? null) : null
  const visible = useMemo(() => (flows ?? []).filter((f) => inSpace(flowSpace(f), space)), [flows, space])
  const selId = mode.kind === 'view' || mode.kind === 'edit' ? mode.id : null
  const selected = selId ? ((flows ?? []).find((f) => f.id === selId) ?? null) : null

  useEffect(() => {
    if (mode.kind === 'none' && visible.length) setMode({ kind: 'view', id: visible[0].id })
    if ((mode.kind === 'view' || mode.kind === 'edit') && flows && !flows.some((f) => f.id === mode.id)) setMode({ kind: 'none' })
  }, [mode, visible, flows])

  if (!hasMain()) return <EmptyState className="m-6" tone="warn" title="Workflows indisponíveis fora do app" detail="ficam no main process (flows:*)" />

  return (
    <div className="flex h-full min-h-0">
      <section className="flex w-[300px] shrink-0 flex-col border-r border-edge">
        <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
          <span className="label">Workflows</span>
          {flows && <span className="text-[10.5px] tabular-nums text-faint">{visible.length}</span>}
          <Button size="xs" variant="primary" className="ml-auto" onClick={() => setMode({ kind: 'new' })}>
            + novo
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {state.phase === 'error' && (
            <EmptyState compact tone="error" title="Falha ao ler flows.json" detail={isNoHandler(state.error) ? 'o main desta build não tem flows:* — reabra o app atualizado' : state.error} />
          )}
          {state.phase === 'loading' && <SkeletonLines lines={4} />}
          {flows && !visible.length && (
            <EmptyState compact title={flows.length ? 'Nenhum workflow neste espaço' : 'Nenhum workflow salvo'} detail="um workflow é um conjunto de tarefas do Claude Code que você dispara de uma vez" />
          )}
          <div className="hc-stagger space-y-1">
            {visible.map((f) => (
              <FlowRow key={f.id} flow={f} run={runs[f.id]} active={f.id === selId} onClick={() => setMode({ kind: 'view', id: f.id })} />
            ))}
          </div>
        </div>
      </section>
      <section className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {mode.kind === 'new' && <FlowEditor key="new" flow={null} onCancel={() => setMode({ kind: 'none' })} onSaved={(f) => setMode({ kind: 'view', id: f.id })} />}
        {mode.kind === 'edit' && selected && (
          <FlowEditor key={`e-${selected.id}`} flow={selected} onCancel={() => setMode({ kind: 'view', id: selected.id })} onSaved={(f) => setMode({ kind: 'view', id: f.id })} />
        )}
        {mode.kind === 'view' && selected && <FlowDetail key={selected.id} flow={selected} run={runs[selected.id]} onEdit={() => setMode({ kind: 'edit', id: selected.id })} reload={reload} />}
        {mode.kind === 'none' && flows && !visible.length && (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              title="Monte um workflow"
              detail="ex.: “revisar PRs da Houer” = 3 tarefas em paralelo, uma por repo; ou um pipeline sequencial testar → corrigir → documentar."
              action={<Button size="sm" variant="primary" onClick={() => setMode({ kind: 'new' })}>novo workflow</Button>}
            />
          </div>
        )}
      </section>
    </div>
  )
}

function phaseTone(r: FlowRunState | undefined): string {
  if (!r) return 'bg-faint'
  if (r.phase === 'running' || r.phase === 'starting') return 'bg-phos hc-pulse-dot'
  if (r.phase === 'done') return 'bg-cyanic'
  if (r.phase === 'error') return 'bg-alert'
  return 'bg-faint'
}

function FlowRow({ flow, run, active, onClick }: { flow: Flow; run?: FlowRunState; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'hc-card hc-card-hover hc-press block w-full rounded-md border px-2.5 py-2 text-left transition-colors',
        active ? 'hc-edge-active border-amber/50 bg-amber/[0.06]' : 'border-edge bg-panel/60 hover:border-edge2',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', phaseTone(run))} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{flow.name}</span>
        <span className="text-[9.5px] uppercase tracking-[0.14em] text-faint">{flow.mode === 'parallel' ? '∥' : '→'}</span>
      </div>
      <div className="mt-0.5 flex gap-2 pl-3.5 text-[10.5px] text-faint">
        <span>{flow.tasks.length} tarefas</span>
        <span>· {SPACE_LABEL[flowSpace(flow)]}</span>
        {flow.lastRun && <span className="ml-auto">{fmtAgo(flow.lastRun.at)}</span>}
      </div>
    </button>
  )
}

/** casa cada tarefa com a run correspondente (título, depois ordem) */
function matchRuns(flow: Flow, runIds: string[], all: RunMeta[]): (RunMeta | null)[] {
  const pool = runIds.map((id) => all.find((r) => r.id === id)).filter((r): r is RunMeta => Boolean(r))
  const used = new Set<string>()
  return flow.tasks.map((t, i) => {
    const byTitle = pool.find((r) => !used.has(r.id) && r.title === t.title)
    const r = byTitle ?? pool.filter((x) => !used.has(x.id))[0] ?? (runIds[i] ? (all.find((x) => x.id === runIds[i]) ?? null) : null)
    if (r) used.add(r.id)
    return r ?? null
  })
}

function FlowDetail({ flow, run, onEdit, reload }: { flow: Flow; run?: FlowRunState; onEdit: () => void; reload: () => Promise<void> }) {
  const swarm = useSwarm()
  const live = run && (run.phase === 'running' || run.phase === 'starting')
  const runIds = run?.runIds.length ? run.runIds : (flow.lastRun?.runIds ?? [])
  const matched = matchRuns(flow, runIds, swarm.runs)
  const doneN = matched.filter((r) => r?.status === 'done').length
  const failN = matched.filter((r) => r && (r.status === 'error' || r.status === 'cancelled')).length
  const activeN = matched.filter((r) => r && isActive(r.status)).length
  const pct = flow.tasks.length ? Math.round((doneN / flow.tasks.length) * 100) : 0

  return (
    <div className="hc-fade-in space-y-4 p-4">
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em]">
            <span className="text-amber/80">{flow.mode === 'parallel' ? 'paralelo' : 'sequencial'}</span>
            <span className="text-faint">· {SPACE_LABEL[flowSpace(flow)]}</span>
          </div>
          <h2 className="mt-1 truncate font-display text-[19px] leading-tight text-ink">{flow.name}</h2>
        </div>
        <div className="flex items-center gap-1.5">
          {live ? (
            <ConfirmButton onConfirm={() => stopFlow(flow.id)} confirmLabel="parar?">
              parar sequência
            </ConfirmButton>
          ) : (
            <Button size="xs" variant="primary" onClick={() => void runFlow(flow)} disabled={swarm.phase === 'unavailable'} title={swarm.phase === 'unavailable' ? swarm.error : undefined}>
              ▶ rodar
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={onEdit} disabled={live}>
            editar
          </Button>
          <Button size="xs" variant="ghost" onClick={() => window.dispatchEvent(new CustomEvent('hc:view', { detail: 'swarm' }))}>
            abrir no swarm
          </Button>
          <ConfirmButton
            disabled={live}
            onConfirm={async () => {
              try {
                await flowsApi.remove(flow.id)
                toast({ title: 'Workflow apagado', detail: flow.name, tone: 'ok' })
                await reload()
              } catch (e) {
                toast({ title: 'Falha ao apagar', detail: restMsg(e), tone: 'error' })
              }
            }}
          >
            apagar
          </ConfirmButton>
        </div>
      </header>

      {swarm.phase === 'unavailable' && <EmptyState compact tone="warn" title="Swarm indisponível" detail={swarm.error} />}

      {(runIds.length > 0 || run) && (
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-[11px]">
            <span className="label">{live ? 'Executando' : 'Última execução'}</span>
            <span className="tabular-nums text-dim">
              {doneN}/{flow.tasks.length} concluídas
            </span>
            {activeN > 0 && <span className="text-phos">· {activeN} ativas</span>}
            {failN > 0 && <span className="text-alert">· {failN} falharam</span>}
            <span className="ml-auto text-faint">{flow.lastRun ? fmtAgo(flow.lastRun.at) : ''}</span>
          </div>
          <div className="relative h-1.5 overflow-hidden rounded-full bg-edge">
            <div className="absolute inset-y-0 left-0 rounded-full bg-cyanic transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
            {live && <div className="hc-flow-x absolute inset-0 opacity-60" />}
          </div>
          {run?.error && <div className="mt-2 text-[11px] text-alert">{run.error}</div>}
          {run?.phase === 'stopped' && <div className="mt-2 text-[11px] text-faint">sequência parada — runs já iniciadas continuam no swarm</div>}
        </Card>
      )}

      <div className="relative">
        {flow.mode === 'sequential' && <div className="absolute bottom-4 left-[15px] top-4 w-px bg-edge2" />}
        <ol className="hc-stagger space-y-2">
          {flow.tasks.map((t, i) => {
            const r = matched[i]
            const isCurrent = live && flow.mode === 'sequential' && run?.step === i
            return (
              <li key={i} className="hc-fade-in relative flex gap-3">
                <span
                  className={cx(
                    'relative z-[1] mt-2 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums',
                    r ? cx(STATUS_TONE[r.status].text, 'border-current bg-void') : isCurrent ? 'border-amber text-amber' : 'border-edge2 bg-void text-faint',
                    r && isActive(r.status) && 'hc-glow-phos',
                  )}
                >
                  {r?.status === 'done' ? '✓' : r?.status === 'error' ? '✕' : i + 1}
                </span>
                <Card className={cx('min-w-0 flex-1 p-2.5', isCurrent && 'border-amber/40')}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{t.title}</span>
                    {r && (
                      <span className={cx('text-[10px] uppercase tracking-[0.12em]', STATUS_TONE[r.status].text)}>
                        {STATUS_LABEL[r.status]} · {fmtDuration(runElapsedMs(r))}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[10.5px] text-faint" title={t.cwd}>
                    {t.cwd}
                    {t.model ? ` · ${t.model}` : ''}
                    {t.permissionMode ? ` · ${t.permissionMode}` : ''}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-dim">{t.task}</p>
                  {r?.error && <div className="mt-1 text-[10.5px] text-alert">{r.error}</div>}
                  {r && isActive(r.status) && <div className="hc-flow-x mt-1.5 h-px rounded bg-phos/40" />}
                </Card>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

const EMPTY_TASK = (): FlowTask => ({ title: '', task: '', cwd: '' })

function FlowEditor({ flow, onCancel, onSaved }: { flow: Flow | null; onCancel: () => void; onSaved: (f: Flow) => void }) {
  const cur = getSpace()
  const [draft, setDraft] = useState<FlowDraft>(() =>
    flow
      ? { id: flow.id, name: flow.name, space: flow.space, mode: flow.mode, tasks: flow.tasks.map((t) => ({ ...t })) }
      : { name: '', space: cur === 'tudo' ? 'shared' : cur, mode: 'parallel', tasks: [EMPTY_TASK()] },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setTask = (i: number, patch: Partial<FlowTask>) => setDraft((d) => ({ ...d, tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }))
  const moveTask = (i: number, delta: -1 | 1) =>
    setDraft((d) => {
      const j = i + delta
      if (j < 0 || j >= d.tasks.length) return d
      const tasks = [...d.tasks]
      ;[tasks[i], tasks[j]] = [tasks[j], tasks[i]]
      return { ...d, tasks }
    })

  const save = async () => {
    setError(null)
    if (!draft.name.trim()) return setError('dê um nome ao workflow')
    const bad = draft.tasks.findIndex((t) => !t.task.trim() || !t.cwd.trim().startsWith('/'))
    if (bad >= 0) return setError(`tarefa ${bad + 1}: precisa de instrução e cwd absoluto`)
    setBusy(true)
    try {
      const saved = await flowsApi.save({ ...draft, tasks: draft.tasks.map((t, i) => ({ ...t, title: t.title.trim() || `Tarefa ${i + 1}` })) })
      toast({ title: flow ? 'Workflow salvo' : 'Workflow criado', detail: saved.name, tone: 'ok' })
      onSaved(saved)
    } catch (e) {
      setError(restMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hc-rise space-y-3 p-4">
      <span className="label text-amber">{flow ? 'Editar workflow' : 'Novo workflow'}</span>
      <div className="grid grid-cols-[1fr_150px_170px] gap-3">
        <Field label="Nome">
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="ex.: revisão semanal dos repos" autoFocus={!flow} />
        </Field>
        <Field label="Espaço">
          <Select value={draft.space} onChange={(e) => setDraft({ ...draft, space: e.target.value as ItemSpace })}>
            <option value="houer">Houer</option>
            <option value="pessoal">Pessoal</option>
            <option value="shared">Compartilhado</option>
          </Select>
        </Field>
        <Field label="Modo">
          <div className="flex gap-0.5 rounded-md border border-edge2 p-0.5">
            {(['parallel', 'sequential'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setDraft({ ...draft, mode: m })}
                className={cx(
                  'flex-1 rounded px-1.5 py-1 text-[10px] uppercase tracking-[0.12em] transition-colors',
                  draft.mode === m ? 'bg-amber/15 text-amber' : 'text-faint hover:text-dim',
                )}
              >
                {m === 'parallel' ? '∥ paralelo' : '→ sequencial'}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <p className="text-[10.5px] text-faint">
        {draft.mode === 'parallel' ? 'todas as tarefas sobem juntas, no mesmo grupo do swarm.' : 'uma de cada vez; a próxima só começa quando a anterior termina em "concluída".'}
      </p>
      <div className="space-y-2">
        {draft.tasks.map((t, i) => (
          <Card key={i} className="space-y-2 p-3">
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full border border-edge2 text-[10px] tabular-nums text-dim">{i + 1}</span>
              <Input value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} placeholder={`Tarefa ${i + 1}`} className="flex-1 py-1" />
              <button type="button" className="px-1 text-faint hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => moveTask(i, -1)} aria-label="subir">
                ↑
              </button>
              <button type="button" className="px-1 text-faint hover:text-ink disabled:opacity-30" disabled={i === draft.tasks.length - 1} onClick={() => moveTask(i, 1)} aria-label="descer">
                ↓
              </button>
              <button
                type="button"
                className="px-1 text-faint hover:text-alert disabled:opacity-30"
                disabled={draft.tasks.length === 1}
                onClick={() => setDraft((d) => ({ ...d, tasks: d.tasks.filter((_, j) => j !== i) }))}
                aria-label="remover tarefa"
              >
                ✕
              </button>
            </div>
            <TextArea rows={3} value={t.task} onChange={(e) => setTask(i, { task: e.target.value })} placeholder="instrução para o Claude Code…" />
            <div className="grid grid-cols-[1fr_150px_170px] gap-2">
              <Input value={t.cwd} onChange={(e) => setTask(i, { cwd: e.target.value })} placeholder="/Users/alexandre/dev/projeto" spellCheck={false} />
              <Input value={t.model ?? ''} onChange={(e) => setTask(i, { model: e.target.value || undefined })} placeholder="modelo (opcional)" spellCheck={false} />
              <Select value={t.permissionMode ?? ''} onChange={(e) => setTask(i, { permissionMode: (e.target.value || undefined) as PermissionMode | undefined })}>
                <option value="">permissão padrão</option>
                {(Object.keys(PERM_LABEL) as PermissionMode[]).map((p) => (
                  <option key={p} value={p}>
                    {PERM_LABEL[p]}
                  </option>
                ))}
              </Select>
            </div>
          </Card>
        ))}
        <Button size="xs" variant="outline" disabled={draft.tasks.length >= 16} onClick={() => setDraft((d) => ({ ...d, tasks: [...d.tasks, { ...EMPTY_TASK(), cwd: d.tasks[d.tasks.length - 1]?.cwd ?? '' }] }))}>
          + tarefa
        </Button>
      </div>
      {error && <div className="hc-fade-in rounded-md border border-alert/40 bg-alert/10 px-2.5 py-1.5 text-[11.5px] text-alert">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          cancelar
        </Button>
        <Button size="sm" variant="primary" onClick={save} loading={busy}>
          salvar
        </Button>
      </div>
    </div>
  )
}
