import { useEffect, useMemo, useRef, useState } from 'react'
import { doneStatus, notion, openInNotion, taskInSpace, urgencyCompare, useSpaceMap, type NotionTask } from '../../lib/notion'
import { useSpace } from '../../lib/space'
import { toast } from '../../lib/toast'
import { PanelFrame } from '../panels/PanelFrame'
import type { WidgetProps } from '../panels/widgets'
import { cx } from '../ui/cx'
import { DueChip, PrioMark, TaskCheck } from './parts'
import { useNotionTasks } from './useNotionTasks'

// Widget 'Tarefas' da strip: top tarefas abertas do espaço ativo (atrasadas →
// hoje → em curso → prioridade). O checkbox conclui DE VERDADE no Notion e
// mostra "desfazer" por 5s (desfazer devolve o status anterior).
// CONTRATO: nome do export e props são fixos.

const UNDO_MS = 5000
const TOP = 7

interface Recent {
  task: NotionTask
  prevStatus: string | null
  until: number
}

export function NotionTasksWidget({ refreshMs }: WidgetProps) {
  const space = useSpace()
  const map = useSpaceMap()
  const st = useNotionTasks({ limite: 200 }, { refreshMs })
  const [recent, setRecent] = useState<Map<string, Recent>>(new Map())
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const t = timers.current
    return () => t.forEach(clearTimeout)
  }, [])

  const dropRecent = (id: string) => {
    const t = timers.current.get(id)
    if (t) clearTimeout(t)
    timers.current.delete(id)
    setRecent((m) => {
      const n = new Map(m)
      n.delete(id)
      return n
    })
  }

  const mark = (id: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })

  const complete = async (t: NotionTask) => {
    const done = doneStatus(st.schema)
    if (!done) return toast({ title: 'schema sem status de conclusão', tone: 'warn' })
    mark(t.id, true)
    try {
      await notion.updateTask(t.id, { status: done })
      setRecent((m) => new Map(m).set(t.id, { task: t, prevStatus: t.status, until: Date.now() + UNDO_MS }))
      timers.current.set(
        t.id,
        setTimeout(() => dropRecent(t.id), UNDO_MS),
      )
    } catch (e) {
      toast({ title: 'não concluí no Notion', detail: e instanceof Error ? e.message : String(e), tone: 'error' })
    } finally {
      mark(t.id, false)
    }
  }

  const undo = async (r: Recent) => {
    if (!r.prevStatus) return dropRecent(r.task.id)
    mark(r.task.id, true)
    try {
      st.upsertLocal(await notion.updateTask(r.task.id, { status: r.prevStatus }))
      dropRecent(r.task.id)
    } catch (e) {
      toast({ title: 'não desfiz', detail: e instanceof Error ? e.message : String(e), tone: 'error' })
    } finally {
      mark(r.task.id, false)
    }
  }

  const rows = useMemo(() => {
    const open = st.tasks.filter((t) => t.statusGroup !== 'done' && !recent.has(t.id) && taskInSpace(t, space, map))
    const merged = [...open, ...[...recent.values()].map((r) => r.task).filter((t) => taskInSpace(t, space, map))]
    return merged.sort(urgencyCompare).slice(0, TOP + recent.size)
  }, [st.tasks, recent, space, map])

  const openCount = st.tasks.filter((t) => t.statusGroup !== 'done' && taskInSpace(t, space, map)).length

  return (
    <PanelFrame
      titulo="Tarefas"
      fonte={st.schema ? `Notion · ${openCount} abertas` : 'Notion'}
      error={st.error}
      loading={st.loading && st.tasks.length === 0}
      empty={!st.loading && rows.length === 0}
      emptyText={st.error ? 'sem dados do Notion' : 'nada aberto neste espaço'}
      onRefresh={st.refresh}
    >
      <ul className="hc-stagger space-y-0.5">
        {rows.map((t) => {
          const r = recent.get(t.id)
          return (
            <li key={t.id} className="group relative flex items-center gap-2 overflow-hidden rounded py-[3px] pr-1 text-[11px]">
              <TaskCheck done={!!r} busy={busy.has(t.id)} label={r ? 'concluída' : 'concluir no Notion'} onToggle={() => (r ? void undo(r) : void complete(t))} size={13} />
              <button
                type="button"
                onClick={() => void openInNotion(t.url).catch(() => {})}
                title={`${t.title} — abrir no Notion`}
                className={cx('min-w-0 flex-1 truncate text-left', r ? 'text-faint line-through' : 'text-ink hover:text-amber')}
              >
                {t.title}
              </button>
              {r ? (
                <button
                  type="button"
                  onClick={() => void undo(r)}
                  className="hc-fade-in shrink-0 rounded border border-amber/50 px-1.5 text-[9px] tracking-wider text-amber uppercase hover:bg-amber/10"
                >
                  desfazer
                </button>
              ) : (
                <>
                  {t.statusGroup === 'doing' && <span aria-hidden title={t.status ?? ''} className="hc-pulse-dot h-1 w-1 shrink-0 rounded-full bg-cyanic" />}
                  <PrioMark task={t} />
                  <DueChip date={t.date} />
                </>
              )}
              {r && (
                <span
                  aria-hidden
                  className="hc-countdown absolute inset-x-0 bottom-0 h-px bg-amber/70"
                  style={{ animationDuration: `${Math.max(0, r.until - Date.now())}ms` }}
                />
              )}
            </li>
          )
        })}
      </ul>
    </PanelFrame>
  )
}
