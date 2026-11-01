// Operações de alto nível sobre runs: criar/spawnar runner, continuar (resume),
// cancelar, limpar worktree, resumir resultado. Usado por server.mjs (MCP) e
// cli.mjs (chamado pelo main do cockpit).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOME,
  TERMINAL,
  effective,
  ensureDirs,
  listApprovals,
  listRuns,
  newGroupId,
  newRunId,
  nowIso,
  pidAlive,
  readMeta,
  runDir,
  writeMeta,
  eventsPath,
  normalizePermissionMode,
} from './state.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const RUNNER = join(HERE, '..', 'run.mjs')

const BIN_DIRS = [join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']

/** Binário por caminhos conhecidos (app empacotado e Hermes têm PATH mínimo). */
export function resolveBin(name, envVar) {
  if (envVar && process.env[envVar] && existsSync(process.env[envVar])) return process.env[envVar]
  for (const d of BIN_DIRS) {
    const c = join(d, name)
    if (existsSync(c)) return c
  }
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d) continue
    const c = join(d, name)
    if (existsSync(c)) return c
  }
  return null
}

export function expandPath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('cwd obrigatório (caminho absoluto)')
  let out = p.trim()
  if (out === '~') out = HOME
  else if (out.startsWith('~/')) out = join(HOME, out.slice(2))
  if (!isAbsolute(out)) throw new Error(`cwd precisa ser absoluto: ${p}`)
  out = resolve(out)
  if (!existsSync(out) || !statSync(out).isDirectory()) throw new Error(`cwd não existe ou não é diretório: ${out}`)
  assertNotSensitive(out)
  return out
}

// Raízes onde um agente nunca deve rodar (sem worktree ele trabalharia direto
// nelas): HOME, '/', diretórios de sistema e de configuração/segredos.
const SENSITIVE_EXACT = ['/', '/Users', '/Applications', '/Library', '/System', '/private', '/tmp', '/var', HOME]
const SENSITIVE_TREES = ['/etc', '/usr', '/bin', '/sbin', '/System', '/Library', '/private/etc', '/opt/homebrew']
const SENSITIVE_HOME = ['.ssh', '.gnupg', '.aws', '.config', '.kube', '.docker', '.claude', '.hermes', 'Library']

function assertNotSensitive(p) {
  let real = p
  try {
    real = realpathSync(p)
  } catch {
    /* usa p */
  }
  const homeReal = (() => {
    try {
      return realpathSync(HOME)
    } catch {
      return HOME
    }
  })()
  const under = (root) => real === root || real.startsWith(root.endsWith('/') ? root : root + '/')
  const exact = [...SENSITIVE_EXACT, homeReal, '/private/tmp', '/private/var']
  if (exact.includes(real)) throw new Error(`cwd recusado (raiz sensível): ${real}`)
  for (const t of SENSITIVE_TREES) if (under(t)) throw new Error(`cwd recusado (diretório de sistema): ${real}`)
  for (const h of SENSITIVE_HOME) if (under(join(homeReal, h))) throw new Error(`cwd recusado (config/segredos): ${real}`)
}

function clip(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

function spawnRunner(runId) {
  const node = process.execPath
  const child = spawn(node, [RUNNER, runId], {
    detached: true,
    stdio: 'ignore',
    env: runnerEnv(),
  })
  child.unref()
  return child.pid
}

export function runnerEnv() {
  const env = { ...process.env }
  // Herdados do host: não podem chegar ao claude filho.
  for (const k of Object.keys(env)) {
    if (k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete env[k]
  }
  env.PATH = [...BIN_DIRS, env.PATH || ''].join(':')
  // Sem USER/LOGNAME o claude não acha a credencial no Keychain ("Not logged in").
  const user = userInfo().username
  if (!env.USER) env.USER = user
  if (!env.LOGNAME) env.LOGNAME = user
  if (!env.HOME) env.HOME = HOME
  return env
}

/**
 * Cria a run (meta queued) e spawna o runner detached. O runner cria o
 * worktree e assume a escrita de meta.json daí em diante.
 */
export function createRun({ task, cwd, title, model, groupId, requestedBy, resumeFrom, permissionMode }) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('task obrigatória')
  ensureDirs()
  const id = newRunId()
  const repo = expandPath(cwd)
  mkdirSync(runDir(id), { recursive: true })
  writeFileSync(eventsPath(id), '')
  const meta = {
    id,
    ...(groupId ? { groupId } : {}),
    title: title ? clip(title, 80) : clip(task, 60),
    task,
    repo,
    cwd: repo,
    ...(model ? { model: String(model) } : {}),
    permissionMode: normalizePermissionMode(permissionMode ?? resumeFrom?.permissionMode),
    status: 'queued',
    requestedBy: requestedBy || { via: 'cockpit' },
    createdAt: nowIso(),
  }
  if (resumeFrom) {
    // Continuação: mesmo worktree/branch, `claude --resume <sessionId>`.
    Object.assign(meta, {
      repo: resumeFrom.repo,
      cwd: resumeFrom.cwd,
      ...(resumeFrom.branch ? { branch: resumeFrom.branch } : {}),
      ...(resumeFrom.worktree ? { worktree: resumeFrom.worktree } : {}),
      ...(resumeFrom.repoRoot ? { repoRoot: resumeFrom.repoRoot } : {}),
      isolation: resumeFrom.isolation,
      ...(resumeFrom.baseCommit ? { baseCommit: resumeFrom.baseCommit } : {}),
      parentRunId: resumeFrom.id,
      resumeSessionId: resumeFrom.claudeSessionId,
      ...(resumeFrom.groupId && !groupId ? { groupId: resumeFrom.groupId } : {}),
      ...(!model && resumeFrom.model ? { model: resumeFrom.model } : {}),
    })
  }
  writeMeta(meta)
  const pid = spawnRunner(id)
  // Não regravamos meta aqui: a partir do spawn o runner é o escritor único
  // (gravar o pid daqui correria o risco de sobrescrever status 'running').
  return { ...meta, pid }
}

export function spawnMany({ tasks, cwd, model, requestedBy, permissionMode }) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks vazio')
  if (tasks.length > 8) throw new Error('máximo de 8 tarefas por grupo')
  const groupId = newGroupId()
  const runs = tasks.map((t) =>
    createRun({
      task: t.task,
      cwd: t.cwd || cwd,
      title: t.title,
      model: t.model || model,
      groupId,
      requestedBy,
      permissionMode: t.permissionMode || permissionMode,
    }),
  )
  return { groupId, runIds: runs.map((r) => r.id), runs }
}

export function sendRun(runId, message, requestedBy) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('message obrigatória')
  const prev = effective(readMeta(runId))
  if (!TERMINAL.has(prev.status)) throw new Error(`run ${runId} ainda está ${prev.status}; espere terminar ou cancele`)
  if (!prev.claudeSessionId) throw new Error(`run ${runId} não tem claudeSessionId (claude não chegou a iniciar)`)
  if (!existsSync(prev.cwd)) throw new Error(`worktree da run não existe mais: ${prev.cwd}`)
  return createRun({
    task: message,
    cwd: prev.cwd,
    title: `↳ ${prev.title}`,
    requestedBy,
    resumeFrom: prev,
  })
}

/**
 * O pid gravado ainda é o NOSSO runner? Após crash/reboot o número pode ter
 * sido reciclado por outro processo do usuário — não sinalizar nesse caso.
 */
export function isRunnerPid(pid, runId) {
  if (!pid || !pidAlive(pid)) return false
  try {
    const args = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 })
    return args.includes('run.mjs') && args.includes(runId)
  } catch {
    return false
  }
}

export function cancelRun(runId) {
  const meta = readMeta(runId)
  if (TERMINAL.has(meta.status)) return meta
  if (meta.pid && isRunnerPid(meta.pid, runId)) {
    process.kill(meta.pid, 'SIGTERM')
    return { ...meta, status: 'cancelling' }
  }
  // Runner morto: ninguém mais escreve a meta, então marcamos aqui.
  const next = { ...meta, status: 'cancelled', endedAt: nowIso(), error: meta.error || 'cancelado (runner já não estava vivo)' }
  writeMeta(next)
  return next
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
    ...opts,
  }).trim()
}

/** Remove worktree + branch de uma run terminada (e de continuações que o compartilham). */
export function cleanupRun(runId) {
  const meta = effective(readMeta(runId))
  if (!TERMINAL.has(meta.status)) throw new Error(`run ${runId} está ${meta.status}; cancele antes de limpar`)
  if (meta.isolation !== 'worktree') return { removed: false, reason: 'run sem worktree (rodou direto no cwd)' }
  // meta.cwd pode ser um SUBDIRETÓRIO do worktree (run criada a partir de um
  // subdir do repo); git worktree remove exige a raiz.
  const wt = meta.worktree || meta.cwd
  const repo = meta.repoRoot || meta.repo
  const sharing = listRuns(1000).filter(
    (r) => r.id !== runId && (r.worktree || r.cwd) === wt && !TERMINAL.has(effective(r).status),
  )
  if (sharing.length) throw new Error(`worktree em uso por ${sharing.map((r) => r.id).join(', ')}`)
  if (existsSync(wt)) {
    try {
      git(repo, ['worktree', 'remove', '--force', wt])
    } catch {
      // Só apaga na mão se for mesmo um diretório sob WORKTREES_DIR.
      if (meta.worktree) rmSync(wt, { recursive: true, force: true })
      try {
        git(repo, ['worktree', 'prune'])
      } catch {
        /* repo pode ter sumido */
      }
    }
  }
  if (existsSync(wt)) return { removed: false, cwd: wt, branch: meta.branch, error: `worktree ainda existe: ${wt}` }
  let branchError
  if (meta.branch) {
    try {
      git(repo, ['branch', '-D', meta.branch])
    } catch (err) {
      const msg = String(err?.stderr || err?.message || err)
      if (!/not found/i.test(msg)) branchError = msg.trim().slice(0, 300)
    }
  }
  return { removed: true, cwd: wt, branch: meta.branch, ...(branchError ? { branchError } : {}) }
}

export function diffStat(meta) {
  if (!meta.cwd || !existsSync(meta.cwd)) return null
  try {
    const base = meta.baseCommit || 'HEAD'
    const stat = git(meta.cwd, ['diff', '--stat', base])
    const untracked = git(meta.cwd, ['ls-files', '--others', '--exclude-standard'])
    const parts = []
    if (stat) parts.push(stat)
    if (untracked) parts.push('untracked:\n' + untracked.split('\n').map((l) => '  ' + l).join('\n'))
    return parts.join('\n') || '(sem mudanças)'
  } catch {
    return null
  }
}

export function summary(meta) {
  const m = effective(meta)
  const pending = listApprovals({ runId: m.id, status: 'pending' })
  return {
    runId: m.id,
    ...(m.groupId ? { groupId: m.groupId } : {}),
    title: m.title,
    status: m.status,
    cwd: m.cwd,
    ...(m.branch ? { branch: m.branch } : {}),
    ...(m.model ? { model: m.model } : {}),
    createdAt: m.createdAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
    ...(m.numTurns != null ? { numTurns: m.numTurns } : {}),
    ...(m.costUsd != null ? { costUsd: m.costUsd } : {}),
    ...(m.error ? { error: m.error } : {}),
    ...(pending.length ? { pendingApprovals: pending.map((a) => ({ id: a.id, toolName: a.toolName })) } : {}),
  }
}

export function result(runId) {
  const m = effective(readMeta(runId))
  return {
    runId: m.id,
    status: m.status,
    resultText: m.resultText ?? null,
    branch: m.branch ?? null,
    cwd: m.cwd,
    isolation: m.isolation ?? null,
    diffStat: diffStat(m),
    ...(m.error ? { error: m.error } : {}),
    ...(m.costUsd != null ? { costUsd: m.costUsd } : {}),
  }
}

export function claudeVersion() {
  const bin = resolveBin('claude', 'CLAUDE_BIN')
  if (!bin) return null
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000, env: runnerEnv() }).trim()
  } catch {
    return null
  }
}
