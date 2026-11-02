import { useMemo, useState } from 'react'
import { botTitle } from '../../lib/bots'
import { hasMain } from '../../lib/ipc'
import {
  KANBAN_COLUMNS,
  KANBAN_DROPPABLE,
  KANBAN_LABEL,
  type KanbanBoard,
  type KanbanTask,
  fmtAgo,
  kanbanApi,
  knownProfiles,
  restMsg,
  taskSpace,
  usePolled,
} from '../../lib/automations'
import { inSpace, useSpace } from '../../lib/space'
import { isNoHandler } from '../../lib/swarm'
import { toast } from '../../lib/toast'
import { Button, ConfirmButton, EmptyState, Skeleton, Spinner, cx } from '../ui'
import { BotChip, Field, Input, Select, TextArea } from './ui'

// Kanban dos bots (plugin oficial "kanban" do Hermes, ~/.hermes/kanban.db).
// Leitura e escrita passam pelo main (flows:kanban.*) → REST do plugin, que usa
// o mesmo kanban_db transacional do dashboard/CLI — nunca o SQLite direto.
// Arrastar entre colunas = PATCH status (o Hermes valida a transição; recusa
// vira toast). "Rodando" é do dispatcher: não aceita drop manual.

const COL_TONE: Record<string, string> = {
  triage: 'text-faint',
  todo: 'text-dim',
  scheduled: 'text-cyanic',
  ready: 'text-amber',
  running: 'text-phos',
  blocked: 'text-alert',
  review: 'text-cyanic',
  done: 'text-phos/70',
}

export function KanbanTab({ active }: { active: boolean }) {
  const space = useSpace()
  const [boardSlug, setBoardSlug] = useState<string | undefined>(undefined)
  const [boards] = usePolled(() => kanbanApi.boards(), 60_000, active)
  const [state, reload] = usePolled(() => kanbanApi.board(boardSlug), 10_000, active, [boardSlug])
  const [drag, setDrag] = useState<KanbanTask | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [pending, setPending] = useState<Record<string, string>>({})
  const [sel, setSel] = useState<string | null>(null)
  const [bot, setBot] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const board: KanbanBoard | undefined = state.phase === 'ready' ? state.data : state.phase === 'error' ? state.data : undefined
  const all = useMemo(() => (board?.columns ?? []).flatMap((c) => c.tasks), [board])
  const visible = useMemo(() => all.filter((t) => inSpace(taskSpace(t), space) && (!bot || t.assignee === bot)), [all, space, bot])
  const assignees = useMemo(() => [...new Set(all.filter((t) => inSpace(taskSpace(t), space)).map((t) => t.assignee).filter((a): a is string => Boolean(a)))], [all, space])
  const selected = sel ? (all.find((t) => t.id === sel) ?? null) : null

  const byCol = useMemo(() => {
    const m: Record<string, KanbanTask[]> = Object.fromEntries(KANBAN_COLUMNS.map((c) => [c, [] as KanbanTask[]]))
    for (const t of visible) {
      const st = pending[t.id] ?? t.status
      ;(m[st] ?? (m[st] = [])).push(t)
    }
    return m
  }, [visible, pending])

  const move = async (t: KanbanTask, status: string) => {
    if (t.status === status) return
    setPending((p) => ({ ...p, [t.id]: status }))
    try {
      await kanbanApi.move(t.id, status, boardSlug)
      toast({ title: `Movido para ${KANBAN_LABEL[status] ?? status}`, detail: t.title, tone: 'ok', durationMs: 2500 })
      await reload()
    } catch (e) {
      toast({ title: 'Movimento recusado pelo Hermes', detail: restMsg(e), tone: 'error' })
    } finally {
      setPending((p) => {
        const n = { ...p }
        delete n[t.id]
        return n
      })
    }
  }

  if (!hasMain()) return <EmptyState className="m-6" tone="warn" title="Kanban indisponível fora do app" detail="o quadro é lido pelo main process (flows:kanban.*)" />
  if (state.phase === 'error' && !board) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          tone="error"
          title="Kanban indisponível"
          detail={isNoHandler(state.error) ? 'o main desta build não tem flows:kanban.* — reabra o app atualizado' : state.error}
          action={<Button size="xs" variant="outline" onClick={() => void reload()}>tentar de novo</Button>}
        />
      </div>
    )
  }

  const boardList = boards.phase === 'ready' ? boards.data.boards.filter((b) => !b.archived) : []

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-edge px-4 py-2">
        <span className="label">Kanban dos bots</span>
        {boardList.length > 1 && (
          <Select value={boardSlug ?? (boards.phase === 'ready' ? boards.data.current : '')} onChange={(e) => setBoardSlug(e.target.value)} className="w-[160px] py-1">
            {boardList.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.name} {b.total != null ? `(${b.total})` : ''}
              </option>
            ))}
          </Select>
        )}
        <div className="flex flex-wrap gap-1">
          {assignees.length > 0 && (
            <button type="button" onClick={() => setBot(null)} className={chip(!bot)}>
              todos
            </button>
          )}
          {assignees.map((a) => (
            <button key={a} type="button" onClick={() => setBot(bot === a ? null : a)} className={chip(bot === a)}>
              {a}
            </button>
          ))}
        </div>
        {state.phase === 'error' && <span className="text-[10.5px] text-alert" title={state.error}>falha ao atualizar</span>}
        <span className="ml-auto text-[10.5px] tabular-nums text-faint">{visible.length} tarefas</span>
        <Button size="xs" variant="primary" onClick={() => setAdding(true)}>
          + tarefa
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          {!board ? (
            <div className="flex gap-2 p-3">
              {KANBAN_COLUMNS.map((c) => (
                <Skeleton key={c} className="h-64 w-[220px] shrink-0 rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="flex h-full gap-2 p-3">
              {KANBAN_COLUMNS.map((col) => {
                const tasks = byCol[col] ?? []
                const droppable = KANBAN_DROPPABLE.has(col)
                const isOver = over === col && drag && drag.status !== col
                return (
                  <div
                    key={col}
                    onDragOver={(e) => {
                      if (!drag || !droppable) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (over !== col) setOver(col)
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === col ? null : o))
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      setOver(null)
                      if (drag && droppable) void move(drag, col)
                      setDrag(null)
                    }}
                    className={cx(
                      'flex h-full w-[232px] shrink-0 flex-col rounded-lg border transition-[border-color,background-color] duration-150',
                      isOver ? 'border-amber/60 bg-amber/[0.05]' : 'border-edge bg-panel/40',
                      drag && !droppable && 'opacity-50',
                    )}
                  >
                    <div className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-2">
                      <span className={cx('text-[10px] uppercase tracking-[0.16em]', COL_TONE[col])}>{KANBAN_LABEL[col]}</span>
                      <span className="text-[10px] tabular-nums text-faint">{tasks.length}</span>
                      {!droppable && drag && <span className="ml-auto text-[9.5px] text-faint">dispatcher</span>}
                    </div>
                    <div className="hc-stagger min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1.5 pb-2">
                      {tasks.map((t) => (
                        <TaskCard
                          key={t.id}
                          task={t}
                          pending={Boolean(pending[t.id])}
                          selected={sel === t.id}
                          onSelect={() => setSel(sel === t.id ? null : t.id)}
                          onDragStart={() => setDrag(t)}
                          onDragEnd={() => {
                            setDrag(null)
                            setOver(null)
                          }}
                        />
                      ))}
                      {!tasks.length && <div className="px-1 py-3 text-center text-[10.5px] text-faint/70">{isOver ? 'soltar aqui' : '—'}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {(selected || adding) && (
          <aside className="hc-slide-left w-[340px] shrink-0 overflow-y-auto border-l border-edge bg-panel/40">
            {adding ? (
              <NewTask
                board={boardSlug}
                defaultAssignee={bot ?? ''}
                onClose={() => setAdding(false)}
                onCreated={(id) => {
                  setAdding(false)
                  void reload()
                  if (id) setSel(id)
                }}
              />
            ) : (
              selected && <TaskDetail key={selected.id} task={selected} board={boardSlug} onClose={() => setSel(null)} reload={reload} onMove={(s) => move(selected, s)} />
            )}
          </aside>
        )}
      </div>
    </div>
  )
}

function chip(on: boolean): string {
  return cx(
    'rounded border px-1.5 py-px text-[10px] uppercase tracking-[0.12em] transition-colors',
    on ? 'border-amber/50 bg-amber/10 text-amber' : 'border-edge2 text-faint hover:text-dim',
  )
}

function prioTone(p: number): string {
  if (p >= 3) return 'border-alert/50 text-alert'
  if (p >= 1) return 'border-amber/50 text-amber'
  if (p < 0) return 'border-edge2 text-faint'
  return 'border-edge2 text-dim'
}

function TaskCard({
  task,
  pending,
  selected,
  onSelect,
  onDragStart,
  onDragEnd,
}: {
  task: KanbanTask
  pending: boolean
  selected: boolean
  onSelect: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const running = task.status === 'running'
  return (
    <div
      draggable={!running && !pending}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', task.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      className={cx(
        'hc-card hc-card-hover hc-fade-in relative cursor-pointer rounded-md border px-2 py-1.5 transition-[border-color,opacity,transform] duration-150',
        selected ? 'hc-edge-active border-amber/50 bg-amber/[0.05]' : 'border-edge bg-panel/80 hover:border-edge2',
        pending && 'opacity-60',
        !running && 'active:scale-[0.98]',
      )}
    >
      {running && <span className="hc-scan pointer-events-none absolute inset-0 rounded-md" />}
      <div className="flex items-start gap-1.5">
        <span className="min-w-0 flex-1 text-[11.5px] leading-snug text-ink">{task.title}</span>
        {pending && <Spinner size={10} className="mt-0.5 text-faint" />}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {task.assignee ? <BotChip name={task.assignee} /> : <span className="text-[10px] text-faint">sem bot</span>}
        {task.priority !== 0 && <span className={cx('rounded border px-1 text-[9.5px] tabular-nums', prioTone(task.priority))}>P{task.priority}</span>}
        {task.progress && task.progress.total > 0 && (
          <span className="text-[9.5px] tabular-nums text-faint">
            {task.progress.done}/{task.progress.total}
          </span>
        )}
        {Boolean(task.comment_count) && <span className="text-[9.5px] tabular-nums text-faint" title="comentários">{task.comment_count} com.</span>}
        {task.warnings && task.warnings.count > 0 && <span className="text-[9.5px] text-alert" title="diagnósticos do Hermes">!{task.warnings.count}</span>}
        <span className="ml-auto text-[9.5px] text-faint">{fmtAgo(task.created_at)}</span>
      </div>
      {running && <div className="hc-flow-x mt-1 h-px rounded bg-phos/50" />}
    </div>
  )
}

function TaskDetail({ task, board, onClose, reload, onMove }: { task: KanbanTask; board?: string; onClose: () => void; reload: () => Promise<void>; onMove: (s: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const profiles = knownProfiles(task.assignee ? [task.assignee] : [])

  const patch = async (p: Parameters<typeof kanbanApi.update>[1], ok: string) => {
    setBusy(true)
    try {
      await kanbanApi.update(task.id, p, board)
      toast({ title: ok, detail: task.title, tone: 'ok', durationMs: 2500 })
      await reload()
    } catch (e) {
      toast({ title: 'Hermes recusou a alteração', detail: restMsg(e), tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hc-fade-in space-y-3 p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cx('text-[10px] uppercase tracking-[0.16em]', COL_TONE[task.status])}>{KANBAN_LABEL[task.status] ?? task.status}</span>
            <code className="text-[10px] text-faint">{task.id}</code>
          </div>
          <h3 className="mt-1 font-display text-[16px] leading-tight text-ink">{task.title}</h3>
        </div>
        <button type="button" onClick={onClose} className="text-faint hover:text-ink" aria-label="fechar">
          ✕
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Bot">
          <Select value={task.assignee ?? ''} disabled={busy} onChange={(e) => void patch({ assignee: e.target.value }, e.target.value ? `Atribuído a ${botTitle(e.target.value)}` : 'Sem bot')}>
            <option value="">— sem bot —</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prioridade">
          <Select value={String(task.priority)} disabled={busy} onChange={(e) => void patch({ priority: Number(e.target.value) }, 'Prioridade alterada')}>
            {[...new Set([-1, 0, 1, 2, 3, task.priority])].sort((a, b) => b - a).map((p) => (
              <option key={p} value={p}>
                P{p}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Mover para">
        <div className="flex flex-wrap gap-1">
          {KANBAN_COLUMNS.filter((c) => KANBAN_DROPPABLE.has(c)).map((c) => (
            <button
              key={c}
              type="button"
              disabled={busy || c === task.status}
              onClick={() => void onMove(c)}
              className={cx(
                'rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] transition-colors disabled:opacity-40',
                c === task.status ? 'border-amber/50 text-amber' : 'border-edge2 text-dim hover:border-faint hover:text-ink',
              )}
            >
              {KANBAN_LABEL[c]}
            </button>
          ))}
        </div>
      </Field>
      {task.body && (
        <div>
          <div className="label mb-1">Descrição</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-void/50 p-2 text-[11.5px] leading-relaxed text-dim">{task.body}</pre>
        </div>
      )}
      {(task.latest_summary || task.result) && (
        <div>
          <div className="label mb-1">Último resultado</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-edge bg-void/50 p-2 text-[11.5px] leading-relaxed text-dim">{task.latest_summary ?? task.result}</pre>
        </div>
      )}
      {task.last_failure_error && <div className="rounded-md border border-alert/40 bg-alert/10 px-2.5 py-1.5 text-[11px] text-alert">{task.last_failure_error}</div>}
      <div className="flex items-center gap-2 pt-1 text-[10.5px] text-faint">
        <span>criada {fmtAgo(task.created_at)}</span>
        {task.completed_at && <span>· feita {fmtAgo(task.completed_at)}</span>}
        <ConfirmButton
          className="ml-auto"
          disabled={busy || task.status === 'running'}
          title={task.status === 'running' ? 'tarefa rodando — espere ou mova antes' : 'apaga a tarefa do kanban'}
          onConfirm={async () => {
            try {
              await kanbanApi.remove(task.id, board)
              toast({ title: 'Tarefa apagada', detail: task.title, tone: 'ok' })
              onClose()
              await reload()
            } catch (e) {
              toast({ title: 'Falha ao apagar', detail: restMsg(e), tone: 'error' })
            }
          }}
        >
          apagar
        </ConfirmButton>
      </div>
    </div>
  )
}

function NewTask({ board, defaultAssignee, onClose, onCreated }: { board?: string; defaultAssignee: string; onClose: () => void; onCreated: (id: string | null) => void }) {
  const space = useSpace()
  const profiles = knownProfiles().filter((p) => inSpace(taskSpace({ id: '', title: '', status: '', priority: 0, assignee: p }), space))
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignee, setAssignee] = useState(defaultAssignee)
  const [priority, setPriority] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (!title.trim()) return setError('dê um título')
    setBusy(true)
    setError(null)
    try {
      const r = await kanbanApi.create({ title: title.trim(), body: body.trim() || undefined, assignee: assignee || undefined, priority, triage: true }, board)
      toast({ title: 'Tarefa criada em Triagem', detail: r.warning ?? title.trim(), tone: r.warning ? 'warn' : 'ok' })
      onCreated(r.task?.id ?? null)
    } catch (e) {
      setError(restMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hc-fade-in space-y-3 p-4">
      <div className="flex items-center">
        <span className="label text-amber">Nova tarefa</span>
        <button type="button" onClick={onClose} className="ml-auto text-faint hover:text-ink" aria-label="fechar">
          ✕
        </button>
      </div>
      <Field label="Título">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </Field>
      <Field label="Descrição (opcional)">
        <TextArea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Bot">
          <Select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">— sem bot —</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Prioridade">
          <Select value={String(priority)} onChange={(e) => setPriority(Number(e.target.value))}>
            {[3, 2, 1, 0, -1].map((p) => (
              <option key={p} value={p}>
                P{p}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className="text-[10.5px] leading-snug text-faint">entra em Triagem — nada é despachado até você mover para Pronto.</p>
      {error && <div className="rounded-md border border-alert/40 bg-alert/10 px-2.5 py-1.5 text-[11.5px] text-alert">{error}</div>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          cancelar
        </Button>
        <Button size="sm" variant="primary" onClick={submit} loading={busy}>
          criar
        </Button>
      </div>
    </div>
  )
}
