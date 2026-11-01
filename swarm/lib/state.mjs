// Estado em disco do swarm (ver docs/SWARM-SPEC.md). Node ESM puro, sem deps.
// Compartilhado por run.mjs, perm.mjs, server.mjs, cli.mjs e install.mjs.
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = homedir()
export const COCKPIT_DIR = join(HOME, '.hermes', 'cockpit')
/** Raiz do estado; HERMES_SWARM_DIR permite isolar testes. */
export const STATE_DIR = process.env.HERMES_SWARM_DIR || join(COCKPIT_DIR, 'swarm')
export const RUNS_DIR = join(STATE_DIR, 'runs')
export const APPROVALS_DIR = join(STATE_DIR, 'approvals')
/** Worktrees centralizados: não sujam o diretório pai dos repos do usuário. */
export const WORKTREES_DIR = process.env.HERMES_SWARM_WORKTREES || join(COCKPIT_DIR, 'worktrees')
export const BIN_DIR = join(COCKPIT_DIR, 'swarm-bin')

export const TERMINAL = new Set(['done', 'error', 'cancelled'])

export function ensureDirs() {
  for (const d of [STATE_DIR, RUNS_DIR, APPROVALS_DIR, WORKTREES_DIR]) mkdirSync(d, { recursive: true })
}

export function nowIso() {
  return new Date().toISOString()
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function newRunId() {
  return `r-${stamp()}-${randomBytes(2).toString('hex')}`
}
export function newGroupId() {
  return `g-${stamp()}-${randomBytes(2).toString('hex')}`
}
export function newApprovalId() {
  return `a-${stamp()}-${randomBytes(3).toString('hex')}`
}

const ID_RE = /^[rga]-\d{8}-\d{6}-[0-9a-f]{4,6}$/
export function assertId(id, kind = 'id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`${kind} inválido: ${String(id)}`)
  return id
}

/** Escrita atômica: tmp no mesmo diretório + rename. */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, file)
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function runDir(runId) {
  return join(RUNS_DIR, assertId(runId, 'runId'))
}
export function metaPath(runId) {
  return join(runDir(runId), 'meta.json')
}
export function eventsPath(runId) {
  return join(runDir(runId), 'events.jsonl')
}

export function readMeta(runId) {
  return readJson(metaPath(runId))
}

export function writeMeta(meta) {
  writeJsonAtomic(metaPath(meta.id), meta)
}

/** Lê, aplica patch e regrava (único escritor de meta enquanto vivo: o runner). */
export function patchMeta(runId, patch) {
  const meta = readMeta(runId)
  const next = { ...meta, ...patch }
  writeMeta(next)
  return next
}

export function appendEvent(runId, ev) {
  appendFileSync(eventsPath(runId), JSON.stringify({ ts: nowIso(), ev }) + '\n')
}

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/**
 * Status efetivo: run não-terminal cujo runner morreu (crash, reboot) é
 * reportado como erro — derivado na leitura, sem reescrever o disco.
 */
export function effective(meta) {
  if (!TERMINAL.has(meta.status) && meta.status !== 'queued' && meta.pid && !pidAlive(meta.pid)) {
    return { ...meta, status: 'error', error: meta.error || 'runner encerrou sem finalizar a run (processo morto)' }
  }
  if (meta.status === 'queued' && Date.now() - Date.parse(meta.createdAt) > 60_000) {
    return { ...meta, status: 'error', error: meta.error || 'runner não iniciou em 60s' }
  }
  return meta
}

export function listRuns(limit = 50) {
  if (!existsSync(RUNS_DIR)) return []
  const out = []
  for (const name of readdirSync(RUNS_DIR)) {
    if (!ID_RE.test(name)) continue
    try {
      out.push(effective(readMeta(name)))
    } catch {
      /* meta ausente/corrompido: ignora */
    }
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  return out.slice(0, limit)
}

export function approvalPath(id) {
  return join(APPROVALS_DIR, `${assertId(id, 'approvalId')}.json`)
}

export function listApprovals({ runId, status } = {}) {
  if (!existsSync(APPROVALS_DIR)) return []
  const out = []
  for (const name of readdirSync(APPROVALS_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const a = readJson(join(APPROVALS_DIR, name))
      if (runId && a.runId !== runId) continue
      if (status && a.status !== status) continue
      out.push(a)
    } catch {
      /* arquivo em escrita/corrompido */
    }
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return out
}

/** Decide uma aprovação pendente (idempotente: decisão já tomada não muda). */
export function decideApproval(id, decision, reason, updatedInput) {
  if (decision !== 'allow' && decision !== 'deny') throw new Error(`decisão inválida: ${decision}`)
  const file = approvalPath(id)
  const a = readJson(file)
  if (a.status !== 'pending') return a
  const next = { ...a, status: decision, decidedAt: nowIso() }
  if (reason) next.reason = String(reason)
  if (decision === 'allow' && updatedInput !== undefined) next.updatedInput = updatedInput
  writeJsonAtomic(file, next)
  return next
}
