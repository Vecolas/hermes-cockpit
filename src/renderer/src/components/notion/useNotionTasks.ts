import { useCallback, useEffect, useRef, useState } from 'react'
import { hasMain } from '../../lib/ipc'
import { notion, onNotionChanged, type NotionSchema, type NotionTask, type TaskPatch, type TaskQuery } from '../../lib/notion'

// Carrega schema + tarefas do TO-DO com polling (pausável) e atualizações
// otimistas. Erro de fonte vira `error` (a UI mostra estado honesto) — nunca
// lança para o React. Mudanças feitas em qualquer lugar (view/widget) disparam
// onNotionChanged → recarrega.

export interface NotionTasksState {
  tasks: NotionTask[]
  schema: NotionSchema | null
  loading: boolean
  error: string | null
  truncated: boolean
  updatedAt: number | null
  refresh: () => void
  /** aplica patch otimista; reverte e devolve o erro se a API recusar */
  patch: (id: string, p: TaskPatch) => Promise<NotionTask>
  /** troca local (ex.: tarefa recém-criada) sem esperar o próximo poll */
  upsertLocal: (t: NotionTask) => void
  removeLocal: (id: string) => void
}

export function useNotionTasks(query: TaskQuery, opts: { active?: boolean; refreshMs?: number } = {}): NotionTasksState {
  const { active = true, refreshMs = 60_000 } = opts
  const [tasks, setTasks] = useState<NotionTask[]>([])
  const [schema, setSchema] = useState<NotionSchema | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const seq = useRef(0)
  const qKey = JSON.stringify(query)
  const qRef = useRef(query)
  qRef.current = query

  const load = useCallback(async () => {
    if (!hasMain()) {
      setLoading(false)
      setError('indisponível fora do app (sem main process)')
      return
    }
    const my = ++seq.current
    try {
      const r = await notion.queryTasks(qRef.current)
      if (my !== seq.current) return
      setTasks(r.tasks)
      setSchema(r.schema)
      setTruncated(r.truncated)
      setError(null)
      setUpdatedAt(Date.now())
    } catch (e) {
      if (my !== seq.current) return
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (my === seq.current) setLoading(false)
    }
  }, [])

  // recarrega ao mudar filtros
  useEffect(() => {
    setLoading(true)
    void load()
  }, [qKey, load])

  useEffect(() => {
    if (!active) return
    const t = setInterval(() => void load(), Math.max(15_000, refreshMs))
    return () => clearInterval(t)
  }, [active, refreshMs, load])

  useEffect(() => onNotionChanged(() => void load()), [load])

  const patch = useCallback(
    async (id: string, p: TaskPatch) => {
      let before: NotionTask | undefined
      setTasks((list) =>
        list.map((t) => {
          if (t.id !== id) return t
          before = t
          const statusGroup =
            p.status !== undefined ? (schema?.statuses.find((s) => s.name === p.status)?.group ?? t.statusGroup) : t.statusGroup
          return {
            ...t,
            ...(p.title !== undefined && { title: p.title }),
            ...(p.status !== undefined && { status: p.status, statusGroup }),
            ...(p.prioridade !== undefined && { prioridade: p.prioridade ?? [] }),
            ...(p.categoria !== undefined && { categoria: p.categoria ?? [] }),
            ...(p.date !== undefined && { date: p.date || null }),
          }
        }),
      )
      try {
        // invalida respostas de polling em voo (trariam o estado antigo)
        seq.current++
        const fresh = await notion.updateTask(id, p)
        setTasks((list) => list.map((t) => (t.id === id ? fresh : t)))
        return fresh
      } catch (e) {
        if (before) {
          const b = before
          setTasks((list) => list.map((t) => (t.id === id ? b : t)))
        }
        throw e
      }
    },
    [schema],
  )

  const upsertLocal = useCallback((t: NotionTask) => {
    setTasks((list) => (list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list]))
  }, [])
  const removeLocal = useCallback((id: string) => setTasks((list) => list.filter((x) => x.id !== id)), [])

  return { tasks, schema, loading, error, truncated, updatedAt, refresh: () => void load(), patch, upsertLocal, removeLocal }
}
