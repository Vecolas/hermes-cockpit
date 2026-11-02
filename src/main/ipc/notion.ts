// Domínio "notion" — API oficial do Notion chamada direto do main.
//
// Segredo: NOTION_API_KEY é o MESMO do plugin cockpit. Lemos uma vez rodando o
// python do venv do Hermes (agent.secret_scope → env → ~/.hermes/.env, igual a
// _secret() em ~/.hermes/plugins/cockpit/dashboard/plugin_api.py) e guardamos
// só em memória. A chave NUNCA vai ao renderer nem a log; erros de execução
// do python são resumidos sem stdout/stderr (poderiam conter o valor).
//
// API: Notion-Version 2025-09-03 (data sources). O TO-DO do Alexandre é o data
// source 380a5c53-2df8-80fe-bd9d-000b2ff91729 (Status · Prioridade · Categoria ·
// Date · task). Canais (todos `notion:*`, ver lib/notion.ts no renderer):
//   status · schema · dataSources · search(query)
//   tasks.query(filtros) · tasks.create(input) · tasks.update(id, patch)
//   tasks.archive(id) · tasks.restore(id)
//   page.get(id) → propriedades + blocos em markdown simples (somente leitura)
//   page.append(id, texto) → captura rápida no fim da página

import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { handle } from './index'

const NOTION_VERSION = '2025-09-03'
const API = 'https://api.notion.com/v1'
export const TODO_DATA_SOURCE = '380a5c53-2df8-80fe-bd9d-000b2ff91729'

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const AGENT_DIR = join(HERMES_HOME, 'hermes-agent')
const PY = join(AGENT_DIR, 'venv', 'bin', 'python')

// Mesmo algoritmo de _secret() do plugin. Imprime só o valor (ou nada).
const KEY_SCRIPT = `
import os, sys
from pathlib import Path
def _secret(name):
    try:
        from agent.secret_scope import get_secret_str
        v = (get_secret_str(name, "") or "").strip()
        if v: return v
    except Exception: pass
    v = os.environ.get(name, "").strip()
    if v: return v
    try:
        from hermes_constants import get_hermes_home
        home = Path(str(get_hermes_home()))
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
    try:
        from agent.secret_scope import load_env_file
        return (load_env_file(home / ".env").get(name) or "").strip()
    except Exception:
        return ""
sys.stdout.write(_secret("NOTION_API_KEY"))
`

let keyCache: string | null = null
let keyPending: Promise<string> | null = null

function readKey(): Promise<string> {
  if (keyCache) return Promise.resolve(keyCache)
  if (keyPending) return keyPending
  keyPending = new Promise<string>((resolve, reject) => {
    execFile(
      PY,
      ['-c', KEY_SCRIPT],
      {
        cwd: AGENT_DIR,
        timeout: 20_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, PYTHONPATH: AGENT_DIR, HERMES_HOME, PYTHONDONTWRITEBYTECODE: '1' },
      },
      (err, stdout) => {
        if (err) {
          // sem stdout/stderr na mensagem — podem conter o segredo
          const code = (err as NodeJS.ErrnoException).code
          reject(new Error(code === 'ENOENT' ? `python do Hermes não encontrado (${PY})` : 'falha ao ler NOTION_API_KEY pelo Hermes'))
          return
        }
        const k = String(stdout).trim()
        if (!k) {
          reject(new Error('NOTION_API_KEY ausente no escopo do Hermes'))
          return
        }
        keyCache = k
        resolve(k)
      },
    )
  }).finally(() => {
    keyPending = null
  })
  return keyPending
}

class NotionError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function notion<T = Record<string, unknown>>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown } = {},
  attempt = 0,
): Promise<T> {
  const key = await readKey()
  let res: Response
  try {
    res = await fetch(API + path, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError' ? 'tempo esgotado' : 'sem rede'
    throw new NotionError(`Notion: ${msg}`, 0)
  }
  if (res.status === 429 && attempt < 2) {
    const wait = Math.min(5, Number(res.headers.get('retry-after')) || 1)
    await new Promise((r) => setTimeout(r, wait * 1000))
    return notion<T>(path, init, attempt + 1)
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    if (res.status === 401) keyCache = null // chave trocada/revogada: relê na próxima
    const m = data && typeof data === 'object' ? String((data as { message?: unknown }).message ?? '') : ''
    throw new NotionError(`Notion ${res.status}: ${m || res.statusText || 'erro'}`, res.status)
  }
  return data as T
}

// ─── validação ──────────────────────────────────────────────────────────────

function nid(v: unknown): string {
  if (typeof v !== 'string') throw new Error('id do Notion inválido')
  const hex = v.replace(/-/g, '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('id do Notion inválido')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function str(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 20) : []
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/

// ─── tipos de saída (espelhados em renderer/src/lib/notion.ts) ──────────────

interface Opt {
  name: string
  color: string
}
interface StatusOpt extends Opt {
  group: 'todo' | 'doing' | 'done'
}
interface Schema {
  dataSourceId: string
  title: string
  url: string | null
  titleProp: string
  statusProp: string | null
  priorityProp: string | null
  categoryProp: string | null
  dateProp: string | null
  statuses: StatusOpt[]
  priorities: Opt[]
  categories: Opt[]
  props: { name: string; type: string }[]
}
interface Task {
  id: string
  title: string
  status: string | null
  statusGroup: 'todo' | 'doing' | 'done' | null
  prioridade: string[]
  categoria: string[]
  date: string | null
  end: string | null
  url: string
  lastEdited: string
  createdTime: string
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : [])
const plain = (rich: unknown): string => arr(rich).map((t) => String(t.plain_text ?? '')).join('')

// ─── schema ─────────────────────────────────────────────────────────────────

let schemaCache: { at: number; value: Schema } | null = null

function groupOf(name: string): StatusOpt['group'] {
  const n = name.toLowerCase()
  if (n.includes('complete') || n.includes('done') || n.includes('conclu')) return 'done'
  if (n.includes('progress') || n.includes('andamento') || n.includes('doing')) return 'doing'
  return 'todo'
}

async function schema(force = false): Promise<Schema> {
  if (!force && schemaCache && Date.now() - schemaCache.at < 5 * 60_000) return schemaCache.value
  const d = await notion<Json>(`/data_sources/${TODO_DATA_SOURCE}`)
  const props = obj(d.properties)
  const entries = Object.entries(props).map(([name, p]) => ({ name, ...obj(p) }) as Json & { name: string })
  const byType = (t: string) => entries.filter((p) => p.type === t)
  const pick = (t: string, prefer: RegExp) => byType(t).find((p) => prefer.test(p.name)) ?? byType(t)[0]

  const title = byType('title')[0]
  const status = byType('status')[0]
  const prio = pick('multi_select', /priori/i) ?? pick('select', /priori/i)
  const cat = entries.find((p) => /categ|área|area|projeto|espa/i.test(p.name) && (p.type === 'multi_select' || p.type === 'select'))
  const date = pick('date', /date|prazo|data|due/i)

  const opts = (p: Json | undefined): Opt[] =>
    p ? arr(obj(p[String(p.type)]).options).map((o) => ({ name: String(o.name ?? ''), color: String(o.color ?? 'default') })) : []

  let statuses: StatusOpt[] = []
  if (status) {
    const cfg = obj(status.status)
    const groups = arr(cfg.groups)
    const groupByOpt = new Map<string, StatusOpt['group']>()
    for (const g of groups) for (const id of (g.option_ids as string[]) ?? []) groupByOpt.set(id, groupOf(String(g.name ?? '')))
    statuses = arr(cfg.options).map((o) => ({
      name: String(o.name ?? ''),
      color: String(o.color ?? 'default'),
      group: groupByOpt.get(String(o.id)) ?? groupOf(String(o.name ?? '')),
    }))
  }

  const value: Schema = {
    dataSourceId: TODO_DATA_SOURCE,
    title: plain(d.title) || 'TO-DO',
    url: typeof d.url === 'string' ? d.url : null,
    titleProp: title?.name ?? 'task',
    statusProp: status?.name ?? null,
    priorityProp: prio?.name ?? null,
    categoryProp: cat?.name ?? null,
    dateProp: date?.name ?? null,
    statuses,
    priorities: opts(prio),
    categories: opts(cat),
    props: entries.map((p) => ({ name: p.name, type: String(p.type) })),
  }
  schemaCache = { at: Date.now(), value }
  return value
}

// ─── tarefas ────────────────────────────────────────────────────────────────

function names(p: Json): string[] {
  if (p.type === 'multi_select') return arr(p.multi_select).map((o) => String(o.name ?? ''))
  if (p.type === 'select') return p.select ? [String(obj(p.select).name ?? '')] : []
  return []
}

function toTask(page: Json, s: Schema): Task {
  const props = obj(page.properties)
  const st = s.statusProp ? obj(obj(props[s.statusProp]).status) : {}
  const stName = typeof st.name === 'string' ? st.name : null
  const dt = s.dateProp ? obj(obj(props[s.dateProp]).date) : {}
  return {
    id: String(page.id),
    title: plain(obj(props[s.titleProp]).title).trim() || '(sem título)',
    status: stName,
    statusGroup: stName ? (s.statuses.find((x) => x.name === stName)?.group ?? groupOf(stName)) : null,
    prioridade: s.priorityProp ? names(obj(props[s.priorityProp])) : [],
    categoria: s.categoryProp ? names(obj(props[s.categoryProp])) : [],
    date: typeof dt.start === 'string' ? dt.start : null,
    end: typeof dt.end === 'string' ? dt.end : null,
    url: String(page.url ?? ''),
    lastEdited: String(page.last_edited_time ?? ''),
    createdTime: String(page.created_time ?? ''),
  }
}

interface TaskQuery {
  status?: string[]
  prioridade?: string[]
  /** categorias aceitas (o renderer traduz o espaço em categorias) */
  categorias?: string[]
  /** inclui tarefas sem categoria junto com `categorias` */
  semCategoria?: boolean
  prazo?: 'todas' | 'hoje' | 'atrasadas' | 'semana' | 'sem-prazo' | 'com-prazo'
  incluirConcluidas?: boolean
  limite?: number
  /** data local YYYY-MM-DD de "hoje" (fuso do renderer) */
  hoje?: string
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

function selectFilter(prop: string, type: string, value: string): Json {
  return type === 'select' ? { property: prop, select: { equals: value } } : { property: prop, multi_select: { contains: value } }
}

async function queryTasks(raw: unknown): Promise<{ tasks: Task[]; truncated: boolean; schema: Schema }> {
  const q = obj(raw) as TaskQuery
  const s = await schema()
  const typeOf = (n: string | null) => s.props.find((p) => p.name === n)?.type ?? 'multi_select'
  const and: Json[] = []

  const status = strList(q.status)
  if (s.statusProp && status.length) and.push({ or: status.map((v) => ({ property: s.statusProp, status: { equals: v } })) })
  else if (s.statusProp && !q.incluirConcluidas) {
    for (const st of s.statuses.filter((x) => x.group === 'done')) and.push({ property: s.statusProp, status: { does_not_equal: st.name } })
  }

  const prio = strList(q.prioridade)
  if (s.priorityProp && prio.length) {
    const t = typeOf(s.priorityProp)
    and.push({ or: prio.map((v) => selectFilter(s.priorityProp!, t, v)) })
  }

  const cats = strList(q.categorias)
  if (s.categoryProp && cats.length) {
    const t = typeOf(s.categoryProp)
    const ors: Json[] = cats.map((v) => selectFilter(s.categoryProp!, t, v))
    if (q.semCategoria) ors.push({ property: s.categoryProp, [t]: { is_empty: true } })
    and.push({ or: ors })
  }

  const today = typeof q.hoje === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.hoje) ? q.hoje : new Date().toISOString().slice(0, 10)
  if (s.dateProp && q.prazo && q.prazo !== 'todas') {
    const P = s.dateProp
    if (q.prazo === 'hoje') and.push({ property: P, date: { equals: today } })
    else if (q.prazo === 'atrasadas') and.push({ property: P, date: { before: today } })
    else if (q.prazo === 'semana')
      and.push({ property: P, date: { on_or_after: today } }, { property: P, date: { on_or_before: addDays(today, 7) } })
    else if (q.prazo === 'sem-prazo') and.push({ property: P, date: { is_empty: true } })
    else if (q.prazo === 'com-prazo') and.push({ property: P, date: { is_not_empty: true } })
  }

  const limit = Math.min(500, Math.max(1, Number(q.limite) || 300))
  const body: Json = {
    page_size: Math.min(100, limit),
    sorts: [
      ...(s.dateProp ? [{ property: s.dateProp, direction: 'ascending' }] : []),
      { timestamp: 'last_edited_time', direction: 'descending' },
    ],
  }
  if (and.length === 1) body.filter = and[0]
  else if (and.length > 1) body.filter = { and }

  const tasks: Task[] = []
  let cursor: string | undefined
  let more = false
  do {
    const page = await notion<Json>(`/data_sources/${TODO_DATA_SOURCE}/query`, {
      method: 'POST',
      body: cursor ? { ...body, start_cursor: cursor } : body,
    })
    for (const p of arr(page.results)) if (!p.in_trash && !p.archived) tasks.push(toTask(p, s))
    more = Boolean(page.has_more)
    cursor = typeof page.next_cursor === 'string' ? page.next_cursor : undefined
  } while (more && cursor && tasks.length < limit)
  return { tasks: tasks.slice(0, limit), truncated: more, schema: s }
}

interface TaskPatch {
  title?: string
  status?: string
  prioridade?: string[] | string | null
  categoria?: string[] | string | null
  /** YYYY-MM-DD (ou ISO); null limpa */
  date?: string | null
}

function buildProps(raw: unknown, s: Schema, creating: boolean): Json {
  const p = obj(raw) as TaskPatch
  const out: Json = {}
  if (p.title !== undefined || creating) {
    const t = str(p.title, 2000).trim()
    if (!t) throw new Error('título vazio')
    out[s.titleProp] = { title: [{ type: 'text', text: { content: t } }] }
  }
  if (p.status !== undefined && s.statusProp) {
    const st = str(p.status, 100)
    if (!s.statuses.some((x) => x.name === st)) throw new Error(`status desconhecido: ${st}`)
    out[s.statusProp] = { status: { name: st } }
  }
  const sel = (prop: string | null, v: unknown, allowed: Opt[], label: string) => {
    if (v === undefined || !prop) return
    const list = v === null ? [] : typeof v === 'string' ? [v] : strList(v)
    for (const n of list) if (!allowed.some((o) => o.name === n)) throw new Error(`${label} desconhecida: ${n}`)
    const type = s.props.find((x) => x.name === prop)?.type
    out[prop] = type === 'select' ? { select: list[0] ? { name: list[0] } : null } : { multi_select: list.map((name) => ({ name })) }
  }
  sel(s.priorityProp, p.prioridade, s.priorities, 'prioridade')
  sel(s.categoryProp, p.categoria, s.categories, 'categoria')
  if (p.date !== undefined && s.dateProp) {
    if (p.date === null || p.date === '') out[s.dateProp] = { date: null }
    else {
      const d = str(p.date, 40)
      if (!DATE_RE.test(d)) throw new Error('data inválida (use AAAA-MM-DD)')
      out[s.dateProp] = { date: { start: d } }
    }
  }
  return out
}

async function createTask(raw: unknown): Promise<Task> {
  const s = await schema()
  const properties = buildProps(raw, s, true)
  const input = obj(raw) as TaskPatch
  if (input.status === undefined && s.statusProp) {
    const def = s.statuses.find((x) => x.group === 'todo')
    if (def) properties[s.statusProp] = { status: { name: def.name } }
  }
  const page = await notion<Json>('/pages', {
    method: 'POST',
    body: { parent: { type: 'data_source_id', data_source_id: TODO_DATA_SOURCE }, properties },
  })
  return toTask(page, s)
}

async function updateTask(id: unknown, patch: unknown): Promise<Task> {
  const pid = nid(id)
  const s = await schema()
  const properties = buildProps(patch, s, false)
  if (!Object.keys(properties).length) throw new Error('nada para atualizar')
  const page = await notion<Json>(`/pages/${pid}`, { method: 'PATCH', body: { properties } })
  return toTask(page, s)
}

async function setTrash(id: unknown, inTrash: boolean): Promise<{ id: string; inTrash: boolean }> {
  const page = await notion<Json>(`/pages/${nid(id)}`, { method: 'PATCH', body: { in_trash: inTrash } })
  return { id: String(page.id), inTrash: Boolean(page.in_trash ?? page.archived) }
}

// ─── busca e data sources ───────────────────────────────────────────────────

interface Hit {
  id: string
  object: 'page' | 'data_source' | 'database'
  title: string
  url: string | null
  icon: string | null
  lastEdited: string
  parent: string | null
}

function iconOf(o: Json): string | null {
  const ic = obj(o.icon)
  return ic.type === 'emoji' && typeof ic.emoji === 'string' ? ic.emoji : null
}

function titleOf(o: Json): string {
  if (o.object === 'data_source' || o.object === 'database') return plain(o.title).trim() || '(sem título)'
  for (const p of Object.values(obj(o.properties))) {
    const pp = obj(p)
    if (pp.type === 'title') return plain(pp.title).trim() || '(sem título)'
  }
  return '(sem título)'
}

function toHit(o: Json): Hit {
  const par = obj(o.parent)
  return {
    id: String(o.id),
    object: (o.object as Hit['object']) ?? 'page',
    title: titleOf(o),
    url: typeof o.url === 'string' ? o.url : null,
    icon: iconOf(o),
    lastEdited: String(o.last_edited_time ?? ''),
    parent: typeof par.type === 'string' ? par.type : null,
  }
}

async function search(query: unknown, opts?: unknown): Promise<{ hits: Hit[]; more: boolean }> {
  const q = str(query, 200).trim()
  const o = obj(opts)
  const body: Json = { page_size: Math.min(50, Math.max(1, Number(o.limite) || 25)) }
  if (q) body.query = q
  if (o.tipo === 'page' || o.tipo === 'data_source') body.filter = { property: 'object', value: o.tipo }
  if (!q) body.sort = { timestamp: 'last_edited_time', direction: 'descending' }
  const r = await notion<Json>('/search', { method: 'POST', body })
  return { hits: arr(r.results).filter((x) => !x.in_trash && !x.archived).map(toHit), more: Boolean(r.has_more) }
}

async function dataSources(): Promise<Hit[]> {
  const out: Hit[] = []
  let cursor: string | undefined
  for (let i = 0; i < 5; i++) {
    const r = await notion<Json>('/search', {
      method: 'POST',
      body: { page_size: 100, filter: { property: 'object', value: 'data_source' }, ...(cursor ? { start_cursor: cursor } : {}) },
    })
    out.push(...arr(r.results).filter((x) => !x.in_trash && !x.archived).map(toHit))
    if (!r.has_more || typeof r.next_cursor !== 'string') break
    cursor = r.next_cursor
  }
  return out
}

// ─── página → markdown simples ──────────────────────────────────────────────

function richMd(rich: unknown): string {
  return arr(rich)
    .map((t) => {
      let s = String(t.plain_text ?? '')
      if (!s) return ''
      const a = obj(t.annotations)
      if (a.code) s = '`' + s + '`'
      if (a.bold) s = `**${s}**`
      if (a.italic) s = `*${s}*`
      if (a.strikethrough) s = `~~${s}~~`
      const href = typeof t.href === 'string' ? t.href : null
      return href ? `[${s}](${href})` : s
    })
    .join('')
}

function propText(p: Json): string {
  switch (p.type) {
    case 'title':
    case 'rich_text':
      return plain(p[p.type])
    case 'status':
    case 'select':
      return String(obj(p[p.type]).name ?? '')
    case 'multi_select':
      return names(p).join(', ')
    case 'date': {
      const d = obj(p.date)
      return d.start ? `${d.start}${d.end ? ` → ${d.end}` : ''}` : ''
    }
    case 'checkbox':
      return p.checkbox ? '☑' : '☐'
    case 'number':
      return p.number == null ? '' : String(p.number)
    case 'url':
    case 'email':
    case 'phone_number':
      return String(p[p.type] ?? '')
    case 'people':
      return arr(p.people).map((u) => String(u.name ?? '?')).join(', ')
    case 'created_time':
    case 'last_edited_time':
      return String(p[p.type] ?? '')
    case 'formula': {
      const f = obj(p.formula)
      return String(f[String(f.type)] ?? '')
    }
    case 'relation':
      return `${arr(p.relation).length} relação(ões)`
    default:
      return ''
  }
}

const MAX_BLOCKS = 400

async function children(id: string, budget: { left: number }): Promise<Json[]> {
  const out: Json[] = []
  let cursor: string | undefined
  do {
    const r = await notion<Json>(`/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`)
    for (const b of arr(r.results)) {
      if (budget.left-- <= 0) return out
      out.push(b)
    }
    cursor = r.has_more && typeof r.next_cursor === 'string' ? r.next_cursor : undefined
  } while (cursor)
  return out
}

async function blocksMd(id: string, depth: number, budget: { left: number }): Promise<string[]> {
  const lines: string[] = []
  const pad = '  '.repeat(depth)
  let n = 0
  for (const b of await children(id, budget)) {
    const t = String(b.type)
    const v = obj(b[t])
    const txt = richMd(v.rich_text)
    switch (t) {
      case 'paragraph':
        lines.push(pad + txt)
        break
      case 'heading_1':
        lines.push(`# ${txt}`)
        break
      case 'heading_2':
        lines.push(`## ${txt}`)
        break
      case 'heading_3':
        lines.push(`### ${txt}`)
        break
      case 'bulleted_list_item':
        lines.push(`${pad}- ${txt}`)
        break
      case 'numbered_list_item':
        lines.push(`${pad}${++n}. ${txt}`)
        break
      case 'to_do':
        lines.push(`${pad}- [${v.checked ? 'x' : ' '}] ${txt}`)
        break
      case 'toggle':
        lines.push(`${pad}▸ ${txt}`)
        break
      case 'quote':
        lines.push(`> ${txt}`)
        break
      case 'callout':
        lines.push(`> ${iconOf(v) ?? 'ℹ'} ${txt}`)
        break
      case 'code':
        lines.push('```' + String(v.language ?? ''), plain(v.rich_text), '```')
        break
      case 'divider':
        lines.push('---')
        break
      case 'child_page':
        lines.push(`${pad}📄 ${String(v.title ?? '')}`)
        break
      case 'child_database':
        lines.push(`${pad}🗂 ${String(v.title ?? '')}`)
        break
      case 'bookmark':
      case 'embed':
      case 'link_preview':
        lines.push(`${pad}<${String(v.url ?? '')}>`)
        break
      case 'image':
      case 'file':
      case 'pdf':
      case 'video':
        lines.push(`${pad}[${t}${plain(v.caption) ? `: ${plain(v.caption)}` : ''}]`)
        break
      case 'table':
        lines.push(`${pad}[tabela]`)
        break
      default:
        if (txt) lines.push(pad + txt)
        else lines.push(`${pad}[${t}]`)
    }
    if (t !== 'numbered_list_item') n = 0
    if (b.has_children && depth < 2 && t !== 'child_page' && t !== 'child_database' && budget.left > 0) {
      lines.push(...(await blocksMd(String(b.id), depth + 1, budget)))
    }
  }
  return lines
}

async function pageGet(id: unknown): Promise<{
  id: string
  title: string
  url: string | null
  icon: string | null
  lastEdited: string
  properties: { name: string; type: string; value: string }[]
  markdown: string
  truncated: boolean
}> {
  const pid = nid(id)
  const page = await notion<Json>(`/pages/${pid}`)
  const budget = { left: MAX_BLOCKS }
  const lines = await blocksMd(pid, 0, budget)
  const properties = Object.entries(obj(page.properties))
    .map(([name, p]) => ({ name, type: String(obj(p).type), value: propText(obj(p)) }))
    .filter((p) => p.type !== 'title')
  return {
    id: String(page.id),
    title: titleOf(page),
    url: typeof page.url === 'string' ? page.url : null,
    icon: iconOf(page),
    lastEdited: String(page.last_edited_time ?? ''),
    properties,
    markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    truncated: budget.left <= 0,
  }
}

function lineBlock(line: string): Json {
  const rt = (s: string) => [{ type: 'text', text: { content: s.slice(0, 2000) } }]
  let m: RegExpMatchArray | null
  if ((m = line.match(/^\s*-\s*\[( |x)\]\s+(.*)$/i))) return { type: 'to_do', to_do: { rich_text: rt(m[2]), checked: m[1].toLowerCase() === 'x' } }
  if ((m = line.match(/^\s*\[\]\s+(.*)$/))) return { type: 'to_do', to_do: { rich_text: rt(m[1]), checked: false } }
  if ((m = line.match(/^\s*[-*]\s+(.*)$/))) return { type: 'bulleted_list_item', bulleted_list_item: { rich_text: rt(m[1]) } }
  if ((m = line.match(/^###\s+(.*)$/))) return { type: 'heading_3', heading_3: { rich_text: rt(m[1]) } }
  if ((m = line.match(/^##\s+(.*)$/))) return { type: 'heading_2', heading_2: { rich_text: rt(m[1]) } }
  if ((m = line.match(/^>\s+(.*)$/))) return { type: 'quote', quote: { rich_text: rt(m[1]) } }
  return { type: 'paragraph', paragraph: { rich_text: rt(line) } }
}

async function pageAppend(id: unknown, text: unknown, opts?: unknown): Promise<{ appended: number }> {
  const pid = nid(id)
  const body = str(text, 20_000).replace(/\r/g, '')
  if (!body.trim()) throw new Error('texto vazio')
  const lines = body.split('\n').filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()))
  const blocks: Json[] = []
  if (obj(opts).carimbo) {
    const now = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
    blocks.push({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `captura · ${now}` }, annotations: { italic: true, color: 'gray' } }] } })
  }
  for (const l of lines) blocks.push(lineBlock(l))
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(`/blocks/${pid}/children`, { method: 'PATCH', body: { children: blocks.slice(i, i + 100) } })
  }
  return { appended: blocks.length }
}

// ─── status ─────────────────────────────────────────────────────────────────

async function status(): Promise<{ ok: boolean; bot: string | null; workspace: string | null; dataSourceId: string; notionVersion: string; error?: string }> {
  try {
    const me = await notion<Json>('/users/me')
    const bot = obj(me.bot)
    return {
      ok: true,
      bot: typeof me.name === 'string' ? me.name : null,
      workspace: typeof bot.workspace_name === 'string' ? bot.workspace_name : null,
      dataSourceId: TODO_DATA_SOURCE,
      notionVersion: NOTION_VERSION,
    }
  } catch (e) {
    return {
      ok: false,
      bot: null,
      workspace: null,
      dataSourceId: TODO_DATA_SOURCE,
      notionVersion: NOTION_VERSION,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export function register(): void {
  handle('notion:status', status)
  handle('notion:schema', (force?: unknown) => schema(force === true))
  handle('notion:dataSources', dataSources)
  handle('notion:search', (q: unknown, opts?: unknown) => search(q, opts))
  handle('notion:tasks.query', (q?: unknown) => queryTasks(q))
  handle('notion:tasks.create', (input: unknown) => createTask(input))
  handle('notion:tasks.update', (id: unknown, patch: unknown) => updateTask(id, patch))
  handle('notion:tasks.archive', (id: unknown) => setTrash(id, true))
  handle('notion:tasks.restore', (id: unknown) => setTrash(id, false))
  handle('notion:page.get', (id: unknown) => pageGet(id))
  handle('notion:page.append', (id: unknown, text: unknown, opts?: unknown) => pageAppend(id, text, opts))
}
