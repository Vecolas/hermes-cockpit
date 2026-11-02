// Automações — crons do Hermes (REST /api/cron/*), blueprints, kanban dos bots
// (via main flows:kanban.* → plugin kanban do serve) e workflows do swarm
// salvos (main flows:* → ~/.hermes/cockpit/flows.json).
//
// Tudo aqui é dado real ou erro honesto: nada de fallback inventado. Agenda é
// calculada no renderer (cron 5 campos, horário local) só para PREVIEW; o
// próximo disparo oficial é sempre o next_run_at do Hermes.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { BOT_GROUPS } from './bots'
import { api, invoke, onMain } from './ipc'
import { type ItemSpace, spaceOfBot, spaceOfPath } from './space'
import { type RunMeta, type RunStatus, errMsg, isActive, swarmApi } from './swarm'
import { toast } from './toast'

// ── tipos: cron ─────────────────────────────────────────────────────────────

export interface CronSchedule {
  kind?: 'cron' | 'interval' | 'once' | string
  expr?: string
  minutes?: number
  run_at?: string
  display?: string
}

export interface CronJob {
  id: string
  name?: string | null
  prompt?: string | null
  skills?: string[] | null
  model?: string | null
  provider?: string | null
  model_snapshot?: string | null
  schedule?: CronSchedule
  schedule_display?: string | null
  enabled: boolean
  state?: string | null
  paused_reason?: string | null
  next_run_at?: string | null
  last_run_at?: string | null
  last_status?: string | null
  last_error?: string | null
  last_delivery_error?: string | null
  failure_streak?: number
  deliver?: string | null
  workdir?: string | null
  script?: string | null
  no_agent?: boolean
  repeat?: { times: number | null; completed: number }
  created_at?: string
  /** profile dono (anotado pelo serve) = bot */
  profile?: string
}

export interface CronRun {
  id: string
  title?: string | null
  started_at?: number
  ended_at?: number | null
  message_count?: number
  preview?: string | null
  is_active?: boolean
  end_reason?: string | null
  profile?: string
  [k: string]: unknown
}

export interface DeliveryTarget {
  id: string
  name: string
  home_target_set: boolean
  home_env_var: string | null
}

export interface BlueprintField {
  name: string
  type: 'enum' | 'text' | 'time' | 'weekdays' | string
  label: string
  default: string | null
  options: string[]
  optional: boolean
  strict?: boolean
  help: string
}

export interface Blueprint {
  key: string
  title: string
  description: string
  category: string
  tags: string[]
  fields: BlueprintField[]
  schedule?: string
  scheduleHuman?: string
  command?: string
}

export interface CronJobInput {
  name: string
  prompt: string
  schedule: string
  deliver: string
  model?: string
  workdir?: string
  paused?: boolean
}

export interface SessionMessage {
  role?: string
  content?: unknown
  tool_name?: string | null
  timestamp?: number
  [k: string]: unknown
}

const enc = encodeURIComponent

export const cronApi = {
  list: () => api<CronJob[]>('/api/cron/jobs'),
  runs: (id: string, profile: string, limit = 20) =>
    api<{ runs: CronRun[] }>(`/api/cron/jobs/${enc(id)}/runs?profile=${enc(profile)}&limit=${limit}`),
  create: (profile: string, body: CronJobInput) =>
    api<CronJob>(`/api/cron/jobs?profile=${enc(profile)}`, { method: 'POST', body }),
  update: (id: string, profile: string, updates: Partial<CronJobInput>) =>
    api<CronJob>(`/api/cron/jobs/${enc(id)}?profile=${enc(profile)}`, { method: 'PUT', body: { updates } }),
  pause: (id: string, profile: string) => api<CronJob>(`/api/cron/jobs/${enc(id)}/pause?profile=${enc(profile)}`, { method: 'POST' }),
  resume: (id: string, profile: string) => api<CronJob>(`/api/cron/jobs/${enc(id)}/resume?profile=${enc(profile)}`, { method: 'POST' }),
  trigger: (id: string, profile: string) => api<CronJob>(`/api/cron/jobs/${enc(id)}/trigger?profile=${enc(profile)}`, { method: 'POST' }),
  remove: (id: string, profile: string) => api<{ ok: boolean }>(`/api/cron/jobs/${enc(id)}?profile=${enc(profile)}`, { method: 'DELETE' }),
  targets: () => api<{ targets: DeliveryTarget[] }>('/api/cron/delivery-targets'),
  blueprints: () => api<{ blueprints: Blueprint[] }>('/api/cron/blueprints'),
  instantiate: (profile: string, blueprint: string, values: Record<string, string>) =>
    api<CronJob>(`/api/cron/blueprints/instantiate?profile=${enc(profile)}`, { method: 'POST', body: { blueprint, values } }),
  messages: (sessionId: string, profile: string, limit = 60) =>
    api<{ messages: SessionMessage[] }>(`/api/sessions/${enc(sessionId)}/messages?profile=${enc(profile)}&limit=${limit}&order=latest`),
}

/** "400 Bad Request: {"detail":"..."}" → "..." */
export function restMsg(e: unknown): string {
  const m = errMsg(e)
  const d = m.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (d) return d[1].replace(/\\"/g, '"')
  const o = m.match(/"detail"\s*:\s*\{[^}]*"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  return o ? o[1] : m
}

export function jobProfile(j: CronJob): string {
  return j.profile || 'default'
}

export function jobSpace(j: CronJob): ItemSpace {
  return spaceOfBot(jobProfile(j))
}

export function jobTitle(j: CronJob): string {
  return (j.name || '').trim() || (j.prompt || '').trim().split('\n')[0].slice(0, 60) || j.id
}

export function jobPaused(j: CronJob): boolean {
  return j.state === 'paused' || !j.enabled
}

export type JobTone = 'phos' | 'amber' | 'alert' | 'neutral' | 'cyanic'

export function jobStatus(j: CronJob): { label: string; tone: JobTone } {
  if (j.state === 'running') return { label: 'rodando', tone: 'phos' }
  if (jobPaused(j)) return { label: j.state === 'completed' ? 'concluído' : 'pausado', tone: 'neutral' }
  if (j.state === 'error' || j.last_status === 'error') return { label: 'erro', tone: 'alert' }
  if (j.state === 'completed') return { label: 'concluído', tone: 'cyanic' }
  return { label: 'agendado', tone: 'amber' }
}

/** profiles conhecidos (bots + default), na ordem da rail */
export function knownProfiles(extra: string[] = []): string[] {
  const base = [...Object.keys(BOT_GROUPS), 'default']
  for (const e of extra) if (e && !base.includes(e)) base.push(e)
  return base
}

// ── cron: parse, próximas execuções, linguagem natural (PT-BR) ──────────────

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const DOWS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

interface CronSpec {
  minute: number[]
  hour: number[]
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domStar: boolean
  dowStar: boolean
}

function parseField(raw: string, min: number, max: number, names?: Record<string, number>): number[] {
  const out = new Set<number>()
  for (const part of raw.toLowerCase().split(',')) {
    if (!part) throw new Error(`campo vazio em "${raw}"`)
    const [rangeRaw, stepRaw] = part.split('/')
    const step = stepRaw == null ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) throw new Error(`passo inválido "${part}"`)
    const val = (s: string): number => {
      const n = names && s in names ? names[s] : Number(s)
      if (!Number.isInteger(n)) throw new Error(`valor inválido "${s}"`)
      return n
    }
    let lo: number
    let hi: number
    if (rangeRaw === '*') {
      lo = min
      hi = max
    } else if (rangeRaw.includes('-')) {
      const [a, b] = rangeRaw.split('-')
      lo = val(a)
      hi = val(b)
    } else {
      lo = val(rangeRaw)
      hi = stepRaw == null ? lo : max
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`fora do intervalo ${min}-${max}: "${part}"`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/)
  if (f.length < 5 || f.length > 6) throw new Error('use 5 campos: minuto hora dia mês dia-da-semana')
  const dow = parseField(f[4], 0, 7, DOWS).map((d) => (d === 7 ? 0 : d))
  return {
    minute: parseField(f[0], 0, 59),
    hour: parseField(f[1], 0, 23),
    dom: new Set(parseField(f[2], 1, 31)),
    month: new Set(parseField(f[3], 1, 12, MONTHS)),
    dow: new Set(dow),
    domStar: f[2] === '*' || f[2] === '?',
    dowStar: f[4] === '*' || f[4] === '?',
  }
}

/** Próximas `n` execuções de uma expressão cron depois de `from` (horário local). */
export function nextCronRuns(expr: string, from: Date, n: number): Date[] {
  const s = parseCron(expr)
  const out: Date[] = []
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let i = 0; i < 400 * 2 && out.length < n; i++) {
    const m = day.getMonth() + 1
    const domOk = s.dom.has(day.getDate())
    const dowOk = s.dow.has(day.getDay())
    const dayOk = s.month.has(m) && (s.domStar || s.dowStar ? (s.domStar || domOk) && (s.dowStar || dowOk) : domOk || dowOk)
    if (dayOk) {
      for (const h of s.hour) {
        for (const mi of s.minute) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi)
          if (t > from) {
            out.push(t)
            if (out.length >= n) return out
          }
        }
      }
    }
    day.setDate(day.getDate() + 1)
  }
  return out
}

/** "every 30m" / "every 2h" / "30m" → minutos (null se não for intervalo) */
export function intervalMinutes(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^(?:every\s+)?(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/)
  if (!m) return null
  const n = Number(m[1])
  const u = m[2][0]
  return u === 'h' ? n * 60 : u === 'd' ? n * 1440 : n
}

/** Próximas execuções de uma string de agenda do formulário (preview). */
export function previewRuns(schedule: string, n = 5, from = new Date()): { runs: Date[]; error?: string } {
  const s = schedule.trim()
  if (!s) return { runs: [], error: 'agenda vazia' }
  const iv = intervalMinutes(s)
  if (iv != null) {
    if (iv <= 0) return { runs: [], error: 'intervalo precisa ser > 0' }
    return { runs: Array.from({ length: n }, (_, i) => new Date(from.getTime() + (i + 1) * iv * 60_000)) }
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return { runs: [], error: 'data inválida' }
    return { runs: d > from ? [d] : [], error: d > from ? undefined : 'data no passado' }
  }
  try {
    return { runs: nextCronRuns(s, from, n) }
  } catch (e) {
    return { runs: [], error: errMsg(e) }
  }
}

/** Próximas execuções de um job real: next_run_at oficial + projeção local. */
export function jobNextRuns(j: CronJob, n = 5, from = new Date()): Date[] {
  if (jobPaused(j) || j.state === 'completed') return []
  const official = j.next_run_at ? new Date(j.next_run_at) : null
  const first = official && !Number.isNaN(official.getTime()) ? official : null
  const sch = j.schedule ?? {}
  let rest: Date[] = []
  try {
    if (sch.kind === 'interval' && sch.minutes) {
      const base = first ?? new Date(from.getTime() + sch.minutes * 60_000)
      rest = Array.from({ length: n }, (_, i) => new Date(base.getTime() + i * sch.minutes! * 60_000))
      return rest
    }
    if (sch.kind === 'once') return first ? [first] : sch.run_at ? [new Date(sch.run_at)].filter((d) => d > from) : []
    if (sch.expr) rest = nextCronRuns(sch.expr, first ? new Date(first.getTime() - 1000) : from, n)
  } catch {
    rest = []
  }
  if (first && (!rest.length || Math.abs(rest[0].getTime() - first.getTime()) > 30_000)) rest = [first, ...rest]
  return rest.slice(0, n)
}

const DOW_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const DOW_PT_LONG = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']
const pad2 = (n: number) => String(n).padStart(2, '0')

function joinPt(list: string[]): string {
  return list.length <= 1 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`
}

function dayQualifier(dom: string, mon: string, dow: string): string | null {
  if (mon !== '*') return null
  if (dom === '*' && dow === '*') return 'todo dia'
  if (dom === '*') {
    let days: number[]
    try {
      days = parseField(dow, 0, 7, DOWS).map((d) => (d === 7 ? 0 : d))
    } catch {
      return null
    }
    const set = [...new Set(days)].sort()
    if (set.join() === '1,2,3,4,5') return 'dias úteis'
    if (set.join() === '0,6') return 'fins de semana'
    if (set.length === 1) return `toda ${DOW_PT_LONG[set[0]]}`
    return `toda ${joinPt(set.map((d) => DOW_PT[d]))}`
  }
  if (dow === '*' && /^\d+$/.test(dom)) return `dia ${Number(dom)} de cada mês`
  return null
}

/** Expressão cron (5 campos) → frase PT-BR; fallback "cron <expr>". */
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/)
  if (f.length < 5) return expr
  const [m, h, dom, mon, dow] = f
  const q = dayQualifier(dom, mon, dow)
  const isNum = (s: string) => /^\d+$/.test(s)
  if (q && isNum(m) && /^\d+(,\d+)*$/.test(h)) {
    const times = h.split(',').map((x) => `${pad2(Number(x))}:${pad2(Number(m))}`)
    return `${q[0].toUpperCase()}${q.slice(1)} às ${joinPt(times)}`
  }
  if (q && isNum(m) && h === '*') return `A cada hora, no minuto ${pad2(Number(m))}${q === 'todo dia' ? '' : ` · ${q}`}`
  const stepM = m.match(/^\*\/(\d+)$/)
  if (q && stepM && h === '*') return `A cada ${stepM[1]} min${q === 'todo dia' ? '' : ` · ${q}`}`
  const stepH = h.match(/^\*\/(\d+)$/)
  if (q && isNum(m) && stepH) return `A cada ${stepH[1]} h, no minuto ${pad2(Number(m))}${q === 'todo dia' ? '' : ` · ${q}`}`
  const rangeH = h.match(/^(\d+)-(\d+)$/)
  if (q && isNum(m) && rangeH) return `De hora em hora das ${pad2(+rangeH[1])}:${pad2(+m)} às ${pad2(+rangeH[2])}:${pad2(+m)} · ${q}`
  return `cron ${expr}`
}

export function describeMinutes(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? 'A cada dia' : `A cada ${min / 1440} dias`
  if (min % 60 === 0) return min === 60 ? 'A cada hora' : `A cada ${min / 60} h`
  return `A cada ${min} min`
}

/** Frase PT-BR para string do formulário. */
export function describeScheduleString(s: string): string {
  const iv = intervalMinutes(s)
  if (iv != null) return describeMinutes(iv)
  if (/^\d{4}-\d{2}-\d{2}/.test(s.trim())) return `Uma vez em ${fmtDateTime(new Date(s))}`
  return describeCron(s)
}

export function describeJobSchedule(j: CronJob): string {
  const s = j.schedule ?? {}
  if (s.kind === 'interval' && s.minutes) return describeMinutes(s.minutes)
  if (s.kind === 'once' && s.run_at) return `Uma vez em ${fmtDateTime(new Date(s.run_at))}`
  if (s.expr) return describeCron(s.expr)
  return j.schedule_display || s.display || '—'
}

export function fmtDateTime(d: Date): string {
  if (Number.isNaN(d.getTime())) return '—'
  return `${DOW_PT[d.getDay()]} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** contagem regressiva compacta: "2d 3h", "4h 12m", "12:04", "agora" */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'agora'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${pad2(m)}m`
  return `${pad2(m)}:${pad2(s % 60)}`
}

export function fmtAgo(ts: number | string | null | undefined, now = Date.now()): string {
  if (ts == null || ts === '') return '—'
  const t = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts)
  if (Number.isNaN(t)) return '—'
  const diff = Math.round((now - t) / 1000)
  if (diff < 0) return `em ${fmtCountdown(-diff * 1000)}`
  if (diff < 60) return `há ${diff}s`
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`
  return `há ${Math.floor(diff / 86400)} d`
}

// ── construtor visual de agenda ─────────────────────────────────────────────

export type SchedulePreset =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'hourly'; minute: number }
  | { kind: 'interval'; every: number; unit: 'm' | 'h' }
  | { kind: 'raw'; expr: string }

function hm(time: string): [number, number] {
  const m = time.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return [9, 0]
  return [Math.min(23, Number(m[1])), Math.min(59, Number(m[2]))]
}

export function presetToSchedule(p: SchedulePreset): string {
  switch (p.kind) {
    case 'daily': {
      const [h, m] = hm(p.time)
      return `${m} ${h} * * *`
    }
    case 'weekdays': {
      const [h, m] = hm(p.time)
      return `${m} ${h} * * 1-5`
    }
    case 'weekly': {
      const [h, m] = hm(p.time)
      const days = [...new Set(p.days)].sort()
      return `${m} ${h} * * ${days.length ? days.join(',') : '1'}`
    }
    case 'hourly':
      return `${Math.max(0, Math.min(59, p.minute))} * * * *`
    case 'interval':
      return `every ${Math.max(1, Math.round(p.every))}${p.unit}`
    case 'raw':
      return p.expr.trim()
  }
}

/** Reconhece a agenda de um job existente para abrir o construtor no preset certo. */
export function presetFromJob(j: CronJob | null): SchedulePreset {
  if (!j) return { kind: 'daily', time: '09:00' }
  const s = j.schedule ?? {}
  if (s.kind === 'interval' && s.minutes) {
    return s.minutes % 60 === 0 ? { kind: 'interval', every: s.minutes / 60, unit: 'h' } : { kind: 'interval', every: s.minutes, unit: 'm' }
  }
  const expr = s.expr ?? ''
  const f = expr.trim().split(/\s+/)
  if (f.length === 5 && f[2] === '*' && f[3] === '*' && /^\d+$/.test(f[0])) {
    const [m, h, , , dow] = f
    if (h === '*' && dow === '*') return { kind: 'hourly', minute: Number(m) }
    if (/^\d+$/.test(h)) {
      const time = `${pad2(Number(h))}:${pad2(Number(m))}`
      if (dow === '*') return { kind: 'daily', time }
      if (dow === '1-5') return { kind: 'weekdays', time }
      if (/^\d(,\d)*$/.test(dow)) return { kind: 'weekly', days: dow.split(',').map(Number), time }
    }
  }
  return { kind: 'raw', expr: expr || (s.kind === 'once' && s.run_at ? s.run_at : j.schedule_display || '') }
}

// ── hooks utilitários ───────────────────────────────────────────────────────

/** relógio compartilhado (1 setInterval para todas as contagens) */
let nowVal = Date.now()
const nowSubs = new Set<() => void>()
let nowTimer: ReturnType<typeof setInterval> | null = null
function nowSubscribe(fn: () => void): () => void {
  nowSubs.add(fn)
  if (!nowTimer)
    nowTimer = setInterval(() => {
      nowVal = Date.now()
      nowSubs.forEach((f) => f())
    }, 1000)
  return () => {
    nowSubs.delete(fn)
    if (!nowSubs.size && nowTimer) {
      clearInterval(nowTimer)
      nowTimer = null
    }
  }
}
export function useNow(): number {
  return useSyncExternalStore(nowSubscribe, () => nowVal)
}

export type Load<T> = { phase: 'loading' } | { phase: 'ready'; data: T; at: number } | { phase: 'error'; error: string; data?: T }

/** carrega + recarrega a cada `everyMs` enquanto `active` */
export function usePolled<T>(fn: () => Promise<T>, everyMs: number, active: boolean, deps: unknown[] = []): [Load<T>, () => Promise<void>] {
  const [state, setState] = useState<Load<T>>({ phase: 'loading' })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const data = await fn()
        if (alive) setState({ phase: 'ready', data, at: Date.now() })
      } catch (e) {
        if (alive) setState((prev) => ({ phase: 'error', error: restMsg(e), data: prev.phase === 'ready' ? prev.data : prev.phase === 'error' ? prev.data : undefined }))
      }
    }
    if (!active) return
    void run()
    const t = everyMs > 0 ? setInterval(run, everyMs) : null
    return () => {
      alive = false
      if (t) clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, everyMs, tick, ...deps])
  const reload = useCallback(async () => setTick((x) => x + 1), [])
  return [state, reload]
}

// ── kanban ──────────────────────────────────────────────────────────────────

export const KANBAN_COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'] as const
export type KanbanStatus = (typeof KANBAN_COLUMNS)[number] | 'archived'

export const KANBAN_LABEL: Record<string, string> = {
  triage: 'Triagem',
  todo: 'A fazer',
  scheduled: 'Agendado',
  ready: 'Pronto',
  running: 'Rodando',
  blocked: 'Bloqueado',
  review: 'Revisão',
  done: 'Feito',
  archived: 'Arquivado',
}

/** colunas onde soltar um card faz sentido (running é do dispatcher) */
export const KANBAN_DROPPABLE = new Set<string>(['triage', 'todo', 'ready', 'blocked', 'review', 'done'])

export interface KanbanTask {
  id: string
  title: string
  body?: string | null
  assignee?: string | null
  status: string
  priority: number
  created_at?: number
  started_at?: number | null
  completed_at?: number | null
  tenant?: string | null
  result?: string | null
  latest_summary?: string | null
  last_failure_error?: string | null
  comment_count?: number
  progress?: { done: number; total: number } | null
  warnings?: { count: number; highest_severity?: string | null } | null
  workspace_path?: string | null
}

export interface KanbanBoard {
  columns: { name: string; tasks: KanbanTask[] }[]
  assignees: string[]
  tenants: string[]
  now: number
}

export interface KanbanBoardInfo {
  slug: string
  name: string
  is_current?: boolean
  total?: number
  archived?: boolean
}

export const kanbanApi = {
  boards: () => invoke<{ boards: KanbanBoardInfo[]; current: string }>('flows:kanban.boards'),
  board: (board?: string) => invoke<KanbanBoard>('flows:kanban.board', board ? { board } : {}),
  move: (id: string, status: string, board?: string) => invoke<{ task: KanbanTask | null }>('flows:kanban.move', id, status, board),
  update: (id: string, patch: Partial<Pick<KanbanTask, 'assignee' | 'priority' | 'title' | 'body'>>, board?: string) =>
    invoke<{ task: KanbanTask | null }>('flows:kanban.update', id, patch, board),
  create: (input: { title: string; body?: string; assignee?: string; priority?: number; triage?: boolean }, board?: string) =>
    invoke<{ task: KanbanTask | null; warning?: string }>('flows:kanban.create', input, board),
  remove: (id: string, board?: string) => invoke<{ deleted: boolean }>('flows:kanban.delete', id, board),
}

export function taskSpace(t: KanbanTask): ItemSpace {
  return t.assignee ? spaceOfBot(t.assignee) : 'shared'
}

// ── workflows do swarm ──────────────────────────────────────────────────────

export type PermissionMode = 'manual' | 'auto' | 'acceptEdits' | 'bypass'

export interface FlowTask {
  title: string
  task: string
  cwd: string
  model?: string
  permissionMode?: PermissionMode
}

export interface Flow {
  id: string
  name: string
  space: ItemSpace
  mode: 'parallel' | 'sequential'
  tasks: FlowTask[]
  createdAt: string
  updatedAt: string
  lastRun?: { at: string; groupId: string; runIds: string[] }
}

export type FlowDraft = Omit<Flow, 'id' | 'createdAt' | 'updatedAt' | 'lastRun'> & { id?: string }

export const flowsApi = {
  list: () => invoke<Flow[]>('flows:list'),
  save: (f: FlowDraft) => invoke<Flow>('flows:save', f),
  remove: (id: string) => invoke<void>('flows:delete', id),
  run: (id: string) => invoke<{ flow: Flow; groupId: string }>('flows:run', id),
  recordRun: (id: string, runIds: string[]) => invoke<Flow>('flows:recordRun', id, runIds),
}

export function onFlowsChanged(fn: () => void): () => void {
  return onMain('flows:changed', fn)
}

/** espaço efetivo: campo explícito; se 'shared', o dos cwds (quando todos concordam) */
export function flowSpace(f: Pick<Flow, 'space' | 'tasks'>): ItemSpace {
  if (f.space !== 'shared') return f.space
  const sp = [...new Set(f.tasks.map((t) => spaceOfPath(t.cwd)))]
  return sp.length === 1 ? sp[0] : 'shared'
}

// runner (módulo, não componente: sobrevive a troca de aba/view)

export type FlowRunPhase = 'starting' | 'running' | 'done' | 'error' | 'stopped'

export interface FlowRunState {
  flowId: string
  phase: FlowRunPhase
  groupId: string
  runIds: string[]
  /** índice da tarefa em andamento (sequencial) */
  step: number
  total: number
  error?: string
  startedAt: number
}

let runs: Record<string, FlowRunState> = {}
const runSubs = new Set<() => void>()
const stopFlags = new Set<string>()

function setRun(id: string, patch: Partial<FlowRunState>): void {
  const prev = runs[id]
  runs = { ...runs, [id]: { ...(prev as FlowRunState), ...patch } }
  runSubs.forEach((f) => f())
}

export function useFlowRuns(): Record<string, FlowRunState> {
  return useSyncExternalStore(
    (fn) => {
      runSubs.add(fn)
      return () => runSubs.delete(fn)
    },
    () => runs,
  )
}

function waitForRun(runId: string, stopped: () => boolean): Promise<RunStatus | 'stopped'> {
  return new Promise((resolve) => {
    let finished = false
    let busy = false
    const finish = (s: RunStatus | 'stopped') => {
      if (finished) return
      finished = true
      off()
      clearInterval(timer)
      resolve(s)
    }
    const check = async () => {
      if (finished || busy) return
      if (stopped()) return finish('stopped')
      busy = true
      try {
        const list: RunMeta[] = await swarmApi.list(300)
        const r = list.find((x) => x.id === runId)
        if (r && !isActive(r.status)) finish(r.status)
      } catch {
        /* main ocupado: tenta no próximo tick */
      } finally {
        busy = false
      }
    }
    const off = onMain<{ runId?: string }>('swarm:changed', (p) => {
      if (!p?.runId || p.runId === runId) void check()
    })
    const timer = setInterval(check, 4000)
    void check()
  })
}

export function stopFlow(flowId: string): void {
  stopFlags.add(flowId)
  const r = runs[flowId]
  if (r && (r.phase === 'running' || r.phase === 'starting')) setRun(flowId, { phase: 'stopped' })
}

export async function runFlow(flow: Flow): Promise<void> {
  const cur = runs[flow.id]
  if (cur && (cur.phase === 'running' || cur.phase === 'starting')) return
  stopFlags.delete(flow.id)
  runs = { ...runs, [flow.id]: { flowId: flow.id, phase: 'starting', groupId: '', runIds: [], step: 0, total: flow.tasks.length, startedAt: Date.now() } }
  runSubs.forEach((f) => f())
  const stopped = () => stopFlags.has(flow.id)
  try {
    const { groupId } = await flowsApi.run(flow.id)
    setRun(flow.id, { groupId, phase: 'running' })
    const ids: string[] = []
    const spawn = async (t: FlowTask) => {
      const meta = await swarmApi.spawn({
        task: t.task,
        cwd: t.cwd,
        title: t.title,
        groupId,
        ...(t.model ? { model: t.model } : {}),
        ...(t.permissionMode ? { permissionMode: t.permissionMode } : {}),
      })
      ids.push(meta.id)
      setRun(flow.id, { runIds: [...ids] })
      await flowsApi.recordRun(flow.id, ids).catch(() => undefined)
      return meta
    }
    if (flow.mode === 'parallel') {
      const results = await Promise.allSettled(flow.tasks.map((t) => spawn(t)))
      const fail = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (fail) throw fail.reason
      setRun(flow.id, { step: flow.tasks.length })
      // conclusão do paralelo é derivada ao vivo das runs (UI); aqui só esperamos todas.
      const finals = await Promise.all(ids.map((id) => waitForRun(id, stopped)))
      if (stopped()) return setRun(flow.id, { phase: 'stopped' })
      const bad = finals.filter((s) => s !== 'done').length
      if (bad) {
        const error = `${bad} de ${ids.length} tarefas não concluíram`
        setRun(flow.id, { phase: 'error', error })
        toast({ title: `Workflow "${flow.name}" terminou com falhas`, detail: error, tone: 'warn' })
        return
      }
      setRun(flow.id, { phase: 'done' })
    } else {
      for (let i = 0; i < flow.tasks.length; i++) {
        if (stopped()) return setRun(flow.id, { phase: 'stopped' })
        setRun(flow.id, { step: i })
        const meta = await spawn(flow.tasks[i])
        const st = await waitForRun(meta.id, stopped)
        if (st === 'stopped') return setRun(flow.id, { phase: 'stopped' })
        if (st !== 'done') {
          const error = `tarefa ${i + 1} terminou em "${st}" — sequência interrompida`
          setRun(flow.id, { phase: 'error', error })
          toast({ title: `Workflow "${flow.name}" interrompido`, detail: error, tone: 'warn' })
          return
        }
      }
      setRun(flow.id, { phase: 'done', step: flow.tasks.length })
    }
    toast({ title: `Workflow "${flow.name}" concluído`, tone: 'ok' })
  } catch (e) {
    setRun(flow.id, { phase: 'error', error: errMsg(e) })
    toast({ title: `Workflow "${flow.name}" falhou`, detail: errMsg(e), tone: 'error' })
  }
}
