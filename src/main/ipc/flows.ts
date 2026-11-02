// Domínio "flows" — workflows do swarm salvos e kanban dos bots.
//
// 1) Workflows (~/.hermes/cockpit/flows.json, escrita atômica tmp+rename):
//    flows:list → Flow[] · flows:save(flow) → Flow · flows:delete(id) → void
//    flows:run(id) → { flow, groupId } (carimba lastRun e devolve um groupId no
//    formato do swarm; o renderer dispara swarm:spawn por tarefa —
//    paralelo: mesmo groupId; sequencial: encadeado esperando done)
//    flows:recordRun(id, runIds) → Flow (guarda os runIds da última execução)
//    evento flows:changed {} a cada escrita.
//
// 2) Kanban dos bots: o armazenamento é SQLite (~/.hermes/kanban.db e boards em
//    ~/.hermes/kanban/boards/<slug>/), escrito pelo hermes_cli.kanban_db com
//    transações e eventos. NUNCA tocamos no .db direto: tudo passa pela REST do
//    plugin oficial "kanban" do serve (/api/plugins/kanban/*), que usa o mesmo
//    kanban_db (write_txn + notify) — escrita segura e idêntica ao dashboard.
//    flows:kanban.boards · flows:kanban.board({board?, includeArchived?})
//    flows:kanban.task(id, board?) · flows:kanban.move(id, status, board?)
//    flows:kanban.update(id, patch, board?) · flows:kanban.create(input, board?)
//    flows:kanban.delete(id, board?)
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { apiFetch } from '../backend'
import { broadcast, handle } from './index'

const COCKPIT_DIR = join(homedir(), '.hermes', 'cockpit')
const FLOWS_FILE = join(COCKPIT_DIR, 'flows.json')

type PermissionMode = 'manual' | 'auto' | 'acceptEdits' | 'bypass'
const PERMISSION_MODES: PermissionMode[] = ['manual', 'auto', 'acceptEdits', 'bypass']

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
  /** espaço do workflow ('houer' | 'pessoal' | 'shared') */
  space: 'houer' | 'pessoal' | 'shared'
  mode: 'parallel' | 'sequential'
  tasks: FlowTask[]
  createdAt: string
  updatedAt: string
  lastRun?: { at: string; groupId: string; runIds: string[] }
}

interface FlowsFile {
  version: 1
  flows: Flow[]
}

const FLOW_ID_RE = /^f-[0-9a-z]{6,24}$/
const RUN_ID_RE = /^r-\d{8}-\d{6}-[0-9a-f]{4,6}$/

function readFlows(): Flow[] {
  if (!existsSync(FLOWS_FILE)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(FLOWS_FILE, 'utf8'))
  } catch (err) {
    // Arquivo corrompido: não sobrescrever às cegas — a UI mostra o erro.
    throw new Error(`flows.json ilegível: ${err instanceof Error ? err.message : String(err)}`)
  }
  const list = Array.isArray(raw) ? raw : (raw as Partial<FlowsFile>)?.flows
  return Array.isArray(list) ? (list.filter((f) => f && typeof f === 'object' && typeof f.id === 'string') as Flow[]) : []
}

function writeFlows(flows: Flow[]): void {
  mkdirSync(COCKPIT_DIR, { recursive: true })
  const tmp = `${FLOWS_FILE}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  const data: FlowsFile = { version: 1, flows }
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, FLOWS_FILE)
  broadcast('flows:changed', {})
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function sanitizeFlow(input: unknown, existing?: Flow): Flow {
  const f = (input ?? {}) as Partial<Flow>
  const name = str(f.name, 120).trim()
  if (!name) throw new Error('workflow sem nome')
  const tasksIn = Array.isArray(f.tasks) ? f.tasks : []
  if (!tasksIn.length) throw new Error('workflow sem tarefas')
  if (tasksIn.length > 16) throw new Error('máximo de 16 tarefas por workflow')
  const tasks: FlowTask[] = tasksIn.map((t, i) => {
    const task = str(t?.task, 20_000).trim()
    const cwd = str(t?.cwd, 1024).trim()
    if (!task) throw new Error(`tarefa ${i + 1}: instrução vazia`)
    if (!cwd || !isAbsolute(cwd)) throw new Error(`tarefa ${i + 1}: cwd precisa ser caminho absoluto`)
    const out: FlowTask = { title: str(t?.title, 120).trim() || `Tarefa ${i + 1}`, task, cwd }
    const model = str(t?.model, 120).trim()
    if (model) out.model = model
    if (t?.permissionMode && PERMISSION_MODES.includes(t.permissionMode)) out.permissionMode = t.permissionMode
    return out
  })
  const now = new Date().toISOString()
  return {
    id: existing?.id ?? `f-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`,
    name,
    space: f.space === 'houer' || f.space === 'pessoal' ? f.space : 'shared',
    mode: f.mode === 'sequential' ? 'sequential' : 'parallel',
    tasks,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}),
  }
}

function assertFlowId(id: unknown): string {
  if (typeof id !== 'string' || !FLOW_ID_RE.test(id)) throw new Error(`id de workflow inválido: ${String(id)}`)
  return id
}

function newGroupId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `g-${stamp}-${randomBytes(2).toString('hex')}`
}

// ── kanban (REST do plugin oficial) ─────────────────────────────────────────

const KANBAN = '/api/plugins/kanban'
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const BOARD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const KANBAN_STATUSES = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done', 'archived']

function taskId(id: unknown): string {
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) throw new Error(`id de tarefa inválido: ${String(id)}`)
  return encodeURIComponent(id)
}

function boardQ(board: unknown, sep: '?' | '&' = '?'): string {
  if (board == null || board === '') return ''
  if (typeof board !== 'string' || !BOARD_RE.test(board)) throw new Error(`board inválido: ${String(board)}`)
  return `${sep}board=${encodeURIComponent(board)}`
}

/** Erros REST do serve → mensagem útil (detail do FastAPI quando houver). */
async function kanbanCall<T>(path: string, init?: Parameters<typeof apiFetch>[1]): Promise<T> {
  try {
    return (await apiFetch(path, init)) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/^404\b/.test(msg) && /Not Found"?\}?$/.test(msg)) {
      throw new Error('plugin kanban do Hermes não está montado no serve (rota /api/plugins/kanban ausente)')
    }
    const m = msg.match(/"detail"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    throw new Error(m ? m[1].replace(/\\"/g, '"') : msg)
  }
}

const UPDATE_KEYS = ['status', 'assignee', 'priority', 'title', 'body', 'block_reason', 'summary'] as const

function sanitizePatch(patch: unknown): Record<string, unknown> {
  const p = (patch ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of UPDATE_KEYS) {
    if (!(k in p) || p[k] === undefined) continue
    const v = p[k]
    if (k === 'priority') {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new Error('prioridade inválida')
      out.priority = Math.max(-100, Math.min(100, Math.round(n)))
    } else if (k === 'status') {
      if (typeof v !== 'string' || !KANBAN_STATUSES.includes(v)) throw new Error(`status inválido: ${String(v)}`)
      out.status = v
    } else {
      out[k] = v == null ? '' : String(v).slice(0, 20_000)
    }
  }
  if (!Object.keys(out).length) throw new Error('nada para atualizar')
  return out
}

export function register(): void {
  handle('flows:list', () => readFlows())

  handle('flows:save', (input: unknown) => {
    const flows = readFlows()
    const id = (input as Partial<Flow> | null)?.id
    const idx = typeof id === 'string' && id ? flows.findIndex((f) => f.id === assertFlowId(id)) : -1
    const flow = sanitizeFlow(input, idx >= 0 ? flows[idx] : undefined)
    if (idx >= 0) flows[idx] = flow
    else flows.push(flow)
    writeFlows(flows)
    return flow
  })

  handle('flows:delete', (id: unknown) => {
    const fid = assertFlowId(id)
    const flows = readFlows()
    const next = flows.filter((f) => f.id !== fid)
    if (next.length === flows.length) throw new Error('workflow não encontrado')
    writeFlows(next)
  })

  handle('flows:run', (id: unknown) => {
    const fid = assertFlowId(id)
    const flows = readFlows()
    const idx = flows.findIndex((f) => f.id === fid)
    if (idx < 0) throw new Error('workflow não encontrado')
    const groupId = newGroupId()
    flows[idx] = { ...flows[idx], lastRun: { at: new Date().toISOString(), groupId, runIds: [] } }
    writeFlows(flows)
    return { flow: flows[idx], groupId }
  })

  handle('flows:recordRun', (id: unknown, runIds: unknown) => {
    const fid = assertFlowId(id)
    const ids = (Array.isArray(runIds) ? runIds : []).filter((r): r is string => typeof r === 'string' && RUN_ID_RE.test(r))
    const flows = readFlows()
    const idx = flows.findIndex((f) => f.id === fid)
    if (idx < 0) throw new Error('workflow não encontrado')
    const prev = flows[idx].lastRun
    flows[idx] = {
      ...flows[idx],
      lastRun: { at: prev?.at ?? new Date().toISOString(), groupId: prev?.groupId ?? '', runIds: ids.slice(0, 32) },
    }
    writeFlows(flows)
    return flows[idx]
  })

  // kanban
  handle('flows:kanban.boards', () => kanbanCall(`${KANBAN}/boards`))
  handle('flows:kanban.board', (opts?: { board?: string; includeArchived?: boolean }) => {
    const q = new URLSearchParams()
    if (opts?.board) {
      boardQ(opts.board)
      q.set('board', opts.board)
    }
    if (opts?.includeArchived) q.set('include_archived', 'true')
    const qs = q.toString()
    return kanbanCall(`${KANBAN}/board${qs ? `?${qs}` : ''}`)
  })
  handle('flows:kanban.task', (id: unknown, board?: string) => kanbanCall(`${KANBAN}/tasks/${taskId(id)}${boardQ(board)}`))
  handle('flows:kanban.move', (id: unknown, status: unknown, board?: string) =>
    kanbanCall(`${KANBAN}/tasks/${taskId(id)}${boardQ(board)}`, { method: 'PATCH', body: sanitizePatch({ status }) }),
  )
  handle('flows:kanban.update', (id: unknown, patch: unknown, board?: string) =>
    kanbanCall(`${KANBAN}/tasks/${taskId(id)}${boardQ(board)}`, { method: 'PATCH', body: sanitizePatch(patch) }),
  )
  handle('flows:kanban.create', (input: unknown, board?: string) => {
    const i = (input ?? {}) as Record<string, unknown>
    const title = String(i.title ?? '').trim().slice(0, 300)
    if (!title) throw new Error('tarefa sem título')
    const body: Record<string, unknown> = { title, triage: i.triage !== false }
    if (typeof i.body === 'string' && i.body.trim()) body.body = i.body.slice(0, 20_000)
    if (typeof i.assignee === 'string' && i.assignee.trim()) body.assignee = i.assignee.trim().slice(0, 64)
    if (i.priority != null && Number.isFinite(Number(i.priority))) body.priority = Math.round(Number(i.priority))
    return kanbanCall(`${KANBAN}/tasks${boardQ(board)}`, { method: 'POST', body })
  })
  handle('flows:kanban.delete', (id: unknown, board?: string) =>
    kanbanCall(`${KANBAN}/tasks/${taskId(id)}${boardQ(board)}`, { method: 'DELETE' }),
  )
}
