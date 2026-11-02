import { useSyncExternalStore } from 'react'
import { invoke } from './ipc'
import { inSpace, type ItemSpace, type Space } from './space'

// Cliente tipado do domínio `notion:*` (src/main/ipc/notion.ts). A chave do
// Notion fica só no main; aqui só chegam dados. Tipos espelham o main.
//
// Espaço × Notion: o TO-DO tem a propriedade multi_select "Categoria"
// (TRABALHO · PESSOAL · FIAP). Mapeamento padrão: TRABALHO → houer;
// PESSOAL e FIAP → pessoal; sem categoria (ou categoria não mapeada) →
// shared (aparece nos dois espaços). O mapeamento é editável na NotionView
// (engrenagem "espaços") e fica em localStorage `hermes-cockpit.notion.spaceMap`.

export type StatusGroup = 'todo' | 'doing' | 'done'

export interface NotionOpt {
  name: string
  color: string
}
export interface NotionStatusOpt extends NotionOpt {
  group: StatusGroup
}

export interface NotionSchema {
  dataSourceId: string
  title: string
  url: string | null
  titleProp: string
  statusProp: string | null
  priorityProp: string | null
  categoryProp: string | null
  dateProp: string | null
  statuses: NotionStatusOpt[]
  priorities: NotionOpt[]
  categories: NotionOpt[]
  props: { name: string; type: string }[]
}

export interface NotionTask {
  id: string
  title: string
  status: string | null
  statusGroup: StatusGroup | null
  prioridade: string[]
  categoria: string[]
  /** YYYY-MM-DD ou ISO com hora */
  date: string | null
  end: string | null
  url: string
  lastEdited: string
  createdTime: string
}

export type Prazo = 'todas' | 'hoje' | 'atrasadas' | 'semana' | 'sem-prazo' | 'com-prazo'

export interface TaskQuery {
  status?: string[]
  prioridade?: string[]
  categorias?: string[]
  semCategoria?: boolean
  prazo?: Prazo
  incluirConcluidas?: boolean
  limite?: number
  hoje?: string
}

export interface TaskPatch {
  title?: string
  status?: string
  prioridade?: string[] | null
  categoria?: string[] | null
  date?: string | null
}

export interface NotionHit {
  id: string
  object: 'page' | 'data_source' | 'database'
  title: string
  url: string | null
  icon: string | null
  lastEdited: string
  parent: string | null
}

export interface NotionPage {
  id: string
  title: string
  url: string | null
  icon: string | null
  lastEdited: string
  properties: { name: string; type: string; value: string }[]
  markdown: string
  truncated: boolean
}

export interface NotionStatus {
  ok: boolean
  bot: string | null
  workspace: string | null
  dataSourceId: string
  notionVersion: string
  error?: string
}

// ─── chamadas ───────────────────────────────────────────────────────────────

export const notion = {
  status: () => invoke<NotionStatus>('notion:status'),
  schema: (force = false) => invoke<NotionSchema>('notion:schema', force),
  dataSources: () => invoke<NotionHit[]>('notion:dataSources'),
  search: (query: string, opts?: { tipo?: 'page' | 'data_source'; limite?: number }) =>
    invoke<{ hits: NotionHit[]; more: boolean }>('notion:search', query, opts),
  queryTasks: (q: TaskQuery = {}) =>
    invoke<{ tasks: NotionTask[]; truncated: boolean; schema: NotionSchema }>('notion:tasks.query', { hoje: todayYmd(), ...q }),
  createTask: async (input: TaskPatch & { title: string }) => {
    const t = await invoke<NotionTask>('notion:tasks.create', input)
    emitChanged()
    return t
  },
  updateTask: async (id: string, patch: TaskPatch) => {
    const t = await invoke<NotionTask>('notion:tasks.update', id, patch)
    emitChanged()
    return t
  },
  archiveTask: async (id: string) => {
    const r = await invoke<{ id: string; inTrash: boolean }>('notion:tasks.archive', id)
    emitChanged()
    return r
  },
  restoreTask: async (id: string) => {
    const r = await invoke<{ id: string; inTrash: boolean }>('notion:tasks.restore', id)
    emitChanged()
    return r
  },
  getPage: (id: string) => invoke<NotionPage>('notion:page.get', id),
  appendToPage: (id: string, text: string, opts?: { carimbo?: boolean }) =>
    invoke<{ appended: number }>('notion:page.append', id, text, opts),
}

/** abre no navegador padrão via ops:open (só http/https) */
export function openInNotion(url: string | null | undefined): Promise<void> {
  if (!url) return Promise.resolve()
  return invoke<void>('ops:open', { kind: 'url', url })
}

// ─── barramento de mudança (view ↔ widget sincronizados) ────────────────────

const changeSubs = new Set<() => void>()
export function onNotionChanged(fn: () => void): () => void {
  changeSubs.add(fn)
  return () => {
    changeSubs.delete(fn)
  }
}
export function emitChanged(): void {
  changeSubs.forEach((f) => f())
}

// ─── datas ──────────────────────────────────────────────────────────────────

export function todayYmd(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function addDaysYmd(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return todayYmd(new Date(y, m - 1, d + n))
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later' | 'none'

/** classificação do prazo em relação a hoje (local) */
export function dueTone(date: string | null, done = false): DueTone {
  if (!date) return 'none'
  const ymd = date.slice(0, 10)
  const t = todayYmd()
  if (ymd < t) return done ? 'later' : 'overdue'
  if (ymd === t) return 'today'
  if (ymd <= addDaysYmd(t, 2)) return 'soon'
  return 'later'
}

export const DUE_CLASS: Record<DueTone, string> = {
  overdue: 'text-alert',
  today: 'text-amber',
  soon: 'text-cyanic',
  later: 'text-dim',
  none: 'text-faint',
}

export function dueLabel(date: string | null): string {
  if (!date) return 'sem prazo'
  const ymd = date.slice(0, 10)
  const t = todayYmd()
  const hora = date.includes('T')
    ? ' ' + new Date(date).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : ''
  if (ymd === t) return 'hoje' + hora
  if (ymd === addDaysYmd(t, 1)) return 'amanhã' + hora
  if (ymd === addDaysYmd(t, -1)) return 'ontem'
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  const diff = Math.round((dt.getTime() - new Date(t + 'T00:00:00').getTime()) / 86_400_000)
  if (diff < 0) return `${-diff}d atrás`
  if (diff < 7) return dt.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '') + hora
  return dt.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '')
}

// ─── prioridade ─────────────────────────────────────────────────────────────

const PRIO_RANK: Record<string, number> = { HIGH: 0, ALTA: 0, MEDIUM: 1, MÉDIA: 1, MEDIA: 1, LOW: 2, BAIXA: 2 }
export function prioRank(t: NotionTask): number {
  let r = 3
  for (const p of t.prioridade) r = Math.min(r, PRIO_RANK[p.toUpperCase()] ?? 3)
  return r
}

/** cor Notion → token do cockpit */
export function notionColor(c: string | undefined): 'alert' | 'amber' | 'phos' | 'cyanic' | 'neutral' {
  switch (c) {
    case 'red':
    case 'pink':
      return 'alert'
    case 'orange':
    case 'yellow':
    case 'brown':
      return 'amber'
    case 'green':
      return 'phos'
    case 'blue':
    case 'purple':
      return 'cyanic'
    default:
      return 'neutral'
  }
}

/** ordem "o que fazer agora": atrasada > hoje > em curso > prioridade > prazo */
export function urgencyCompare(a: NotionTask, b: NotionTask): number {
  const w = (t: NotionTask) => {
    const d = dueTone(t.date)
    return d === 'overdue' ? 0 : d === 'today' ? 1 : t.statusGroup === 'doing' ? 2 : d === 'soon' ? 3 : 4
  }
  return (
    w(a) - w(b) ||
    prioRank(a) - prioRank(b) ||
    (a.date ?? '9999').localeCompare(b.date ?? '9999') ||
    b.lastEdited.localeCompare(a.lastEdited)
  )
}

// ─── espaço ─────────────────────────────────────────────────────────────────

export type SpaceMap = Record<string, ItemSpace>
const MAP_KEY = 'hermes-cockpit.notion.spaceMap'
export const DEFAULT_SPACE_MAP: SpaceMap = { TRABALHO: 'houer', PESSOAL: 'pessoal', FIAP: 'pessoal' }

let spaceMap: SpaceMap = (() => {
  try {
    const raw = localStorage.getItem(MAP_KEY)
    if (raw) {
      const v = JSON.parse(raw) as unknown
      if (v && typeof v === 'object') return { ...DEFAULT_SPACE_MAP, ...(v as SpaceMap) }
    }
  } catch {
    /* sem storage */
  }
  return { ...DEFAULT_SPACE_MAP }
})()
const mapSubs = new Set<() => void>()

export function getSpaceMap(): SpaceMap {
  return spaceMap
}
export function setSpaceMap(m: SpaceMap): void {
  spaceMap = { ...m }
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify(spaceMap))
  } catch {
    /* sem storage */
  }
  mapSubs.forEach((f) => f())
}
export function useSpaceMap(): SpaceMap {
  return useSyncExternalStore(
    (fn) => {
      mapSubs.add(fn)
      return () => mapSubs.delete(fn)
    },
    () => spaceMap,
  )
}

/** espaço de uma tarefa pelas categorias; categorias conflitantes = shared */
export function spaceOfTask(t: NotionTask, map: SpaceMap = spaceMap): ItemSpace {
  const s = new Set<ItemSpace>()
  for (const c of t.categoria) s.add(map[c] ?? 'shared')
  if (s.size === 1) return [...s][0]
  return 'shared'
}

export function taskInSpace(t: NotionTask, space: Space, map: SpaceMap = spaceMap): boolean {
  return inSpace(spaceOfTask(t, map), space)
}

/** categoria padrão ao criar tarefa num espaço */
export function defaultCategoryFor(space: Space, schema: NotionSchema | null, map: SpaceMap = spaceMap): string[] {
  if (space === 'tudo' || !schema) return []
  const c = schema.categories.find((o) => map[o.name] === space)
  return c ? [c.name] : []
}

export function doneStatus(schema: NotionSchema | null): string | null {
  return schema?.statuses.find((s) => s.group === 'done')?.name ?? null
}
export function todoStatus(schema: NotionSchema | null): string | null {
  return schema?.statuses.find((s) => s.group === 'todo')?.name ?? null
}

/** captura rápida: última página-alvo escolhida */
const CAPTURE_KEY = 'hermes-cockpit.notion.captureTarget'
export function getCaptureTarget(): NotionHit | null {
  try {
    const raw = localStorage.getItem(CAPTURE_KEY)
    return raw ? (JSON.parse(raw) as NotionHit) : null
  } catch {
    return null
  }
}
export function setCaptureTarget(h: NotionHit | null): void {
  try {
    if (h) localStorage.setItem(CAPTURE_KEY, JSON.stringify(h))
    else localStorage.removeItem(CAPTURE_KEY)
  } catch {
    /* sem storage */
  }
}
