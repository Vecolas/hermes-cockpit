#!/usr/bin/env node
// Runner de UMA run do swarm (processo detached; ver docs/SWARM-SPEC.md).
// Uso: node run.mjs <runId>   — meta.json (status queued) já deve existir.
//
// 1. isola: git worktree em ~/.hermes/cockpit/worktrees/<repo>-<runId>, branch
//    hermes/<runId> (se cwd não for repo git com commits, roda direto no cwd e
//    marca isolation:'none' + note no meta). Continuações (resume) reusam o cwd.
// 2. spawna `claude -p` em stream-json com o perm.mjs como permission-prompt-tool.
// 3. grava events.jsonl, stderr.log e meta.json (atômico; escritor único).
// 4. SIGTERM/SIGINT → mata o claude (grupo) e termina como cancelled.
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolveBin } from './lib/runs.mjs'
import {
  STATE_DIR,
  WORKTREES_DIR,
  appendEvent,
  approvalPath,
  ensureDirs,
  listApprovals,
  nowIso,
  readJson,
  readMeta,
  runDir,
  writeJsonAtomic,
  writeMeta,
} from './lib/state.mjs'

const runId = process.argv[2]
if (!runId) {
  process.stderr.write('uso: run.mjs <runId>\n')
  process.exit(2)
}

const PERM = fileURLToPath(new URL('./perm.mjs', import.meta.url))
// Leitura fica liberada. Edição só é pré-aprovada DENTRO do worktree (regras
// com caminho absoluto `//abs/**`); fora dele, ou em runs sem isolamento
// (isolation:'none'), Edit/Write passam pelo perm.mjs → card no cockpit, como
// Bash, WebFetch, MCP externos etc.
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS']
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
function allowedTools() {
  const out = [...READ_TOOLS]
  if (meta.isolation === 'worktree' && meta.worktree && isAbsolute(meta.worktree)) {
    // `//` = caminho absoluto na sintaxe de regras do Claude Code.
    for (const t of EDIT_TOOLS) out.push(`${t}(/${meta.worktree}/**)`)
  }
  return out.join(',')
}

ensureDirs()
let meta = readMeta(runId)
const save = (patch) => {
  meta = { ...meta, ...patch }
  writeMeta(meta)
}

let claude = null
let cancelled = false
let finished = false

function onSignal() {
  if (cancelled) return
  cancelled = true
  if (claude && claude.exitCode === null) {
    try {
      process.kill(-claude.pid, 'SIGTERM')
    } catch {
      try {
        claude.kill('SIGTERM')
      } catch {
        /* já morreu */
      }
    }
    setTimeout(() => {
      try {
        process.kill(-claude.pid, 'SIGKILL')
      } catch {
        /* noop */
      }
    }, 5000).unref()
  } else {
    finish({ status: 'cancelled' })
  }
}
process.on('SIGTERM', onSignal)
process.on('SIGINT', onSignal)
process.on('SIGHUP', () => {}) // sobrevive ao fechamento do terminal/pai

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  }).trim()
}

function isolate() {
  if (meta.isolation) {
    // Continuação: reusa cwd/branch. Metas antigas não traziam `worktree`;
    // deriva do toplevel do cwd, mas só aceita se estiver sob WORKTREES_DIR.
    if (meta.isolation === 'worktree' && !meta.worktree) {
      try {
        const top = realpathSync(git(meta.cwd, ['rev-parse', '--show-toplevel']))
        const rel = relative(realpathSync(WORKTREES_DIR), top)
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)) save({ worktree: top })
      } catch {
        /* sem worktree conhecido: edições passam pelo card de aprovação */
      }
    }
    return
  }
  const requested = meta.repo
  let top
  try {
    top = git(requested, ['rev-parse', '--show-toplevel'])
  } catch {
    save({ isolation: 'none', cwd: requested, note: 'cwd não é repositório git: claude roda direto no cwd' })
    return
  }
  let head
  try {
    head = git(top, ['rev-parse', '--verify', 'HEAD'])
  } catch {
    save({ isolation: 'none', cwd: requested, note: 'repositório sem commits: claude roda direto no cwd' })
    return
  }
  mkdirSync(WORKTREES_DIR, { recursive: true })
  const wt = join(WORKTREES_DIR, `${basename(top)}-${runId}`)
  const branch = `hermes/${runId}`
  git(top, ['worktree', 'add', '-b', branch, wt, head])
  // --show-toplevel devolve o realpath; `requested` pode passar por symlink
  // (/tmp → /private/tmp). Sem realpath, relative() gera '../..' e o cwd escapa.
  let sub = ''
  try {
    sub = relative(realpathSync(top), realpathSync(requested))
  } catch {
    sub = ''
  }
  if (sub.startsWith('..') || isAbsolute(sub)) sub = ''
  save({
    isolation: 'worktree',
    repoRoot: top,
    cwd: sub ? join(wt, sub) : wt,
    worktree: wt,
    branch,
    baseCommit: head,
  })
}

function syncApprovalStatus() {
  if (finished || meta.status === 'queued') return
  const pending = listApprovals({ runId, status: 'pending' }).length
  const want = pending > 0 ? 'waiting_approval' : 'running'
  if (meta.status !== want && (meta.status === 'running' || meta.status === 'waiting_approval')) save({ status: want })
}

function denyLeftovers(reason) {
  for (const a of listApprovals({ runId, status: 'pending' })) {
    try {
      const cur = readJson(approvalPath(a.id))
      if (cur.status === 'pending') writeJsonAtomic(approvalPath(a.id), { ...cur, status: 'deny', decidedAt: nowIso(), reason })
    } catch {
      /* noop */
    }
  }
}

let stderrTail = ''
let poll = null

function finish(patch) {
  if (finished) return
  finished = true
  if (poll) clearInterval(poll)
  denyLeftovers('run terminou antes da decisão')
  save({ endedAt: nowIso(), ...patch })
  setTimeout(() => process.exit(0), 50)
}

function main() {
  save({ pid: process.pid, status: 'running', startedAt: nowIso() })
  try {
    isolate()
  } catch (err) {
    finish({ status: 'error', error: `falha ao criar worktree: ${err?.stderr?.toString?.() || err?.message || err}` })
    return
  }
  const claudeBin = resolveBin('claude', 'CLAUDE_BIN')
  if (!claudeBin) {
    finish({ status: 'error', error: 'binário claude não encontrado (~/.local/bin, /opt/homebrew/bin, PATH)' })
    return
  }
  const mcpConfig = join(runDir(runId), 'mcp.json')
  writeJsonAtomic(mcpConfig, {
    mcpServers: {
      cockpit_perm: {
        type: 'stdio',
        command: process.execPath,
        args: [PERM],
        env: { RUN_ID: runId, HERMES_SWARM_DIR: STATE_DIR },
      },
    },
  })
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    allowedTools(),
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--permission-prompt-tool',
    'mcp__cockpit_perm__approve',
  ]
  // Workers headless enxutos e sem herdar permissões: por padrão NENHUMA fonte
  // de settings é carregada (nem ~/.claude/settings.json, nem o
  // .claude/settings.json commitado no repo — um permissions.allow/defaultMode
  // ali pularia o fluxo de aprovação do cockpit). SWARM_SETTING_SOURCES pode
  // pedir 'user' e/ou 'local' ('all' = user,local); 'project' nunca é aceito.
  const rawSources = (process.env.SWARM_SETTING_SOURCES || '').trim()
  const wanted = rawSources === 'all' ? ['user', 'local'] : rawSources.split(',').map((x) => x.trim())
  const sources = wanted.filter((x) => x === 'user' || x === 'local')
  args.push(`--setting-sources=${sources.join(',')}`)
  // Modo de permissão (meta.permissionMode, ver state.mjs). 'manual' = padrão do CLI.
  const PM = { auto: 'auto', acceptEdits: 'acceptEdits', bypass: 'bypassPermissions' }
  if (PM[meta.permissionMode]) args.push('--permission-mode', PM[meta.permissionMode])
  if (meta.model) args.push('--model', meta.model)
  if (meta.resumeSessionId) args.push('--resume', meta.resumeSessionId)
  args.push('--', meta.task)

  const errLog = createWriteStream(join(runDir(runId), 'stderr.log'), { flags: 'a' })
  if (!existsSync(meta.cwd)) {
    finish({ status: 'error', error: `cwd não existe: ${meta.cwd}` })
    return
  }
  claude = spawn(claudeBin, args, {
    cwd: meta.cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // grupo próprio: SIGTERM no grupo mata subprocessos (Bash etc.)
  })
  save({ claudePid: claude.pid })
  if (cancelled) onSignal()

  let resultSeen = null
  createInterface({ input: claude.stdout, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      ev = { type: 'raw', line }
    }
    appendEvent(runId, ev)
    if (ev.type === 'system' && ev.subtype === 'init') {
      save({ claudeSessionId: ev.session_id, ...(ev.model && !meta.model ? { model: ev.model } : {}) })
    } else if (ev.type === 'result') {
      resultSeen = ev
      save({
        ...(ev.session_id ? { claudeSessionId: ev.session_id } : {}),
        resultText: typeof ev.result === 'string' ? ev.result : meta.resultText,
        numTurns: ev.num_turns,
        costUsd: ev.total_cost_usd ?? ev.cost_usd,
        durationMs: ev.duration_ms,
      })
    }
  })
  claude.stderr.on('data', (chunk) => {
    errLog.write(chunk)
    stderrTail = (stderrTail + chunk.toString()).slice(-2000)
  })
  poll = setInterval(syncApprovalStatus, 500)

  claude.on('error', (err) => finish({ status: 'error', error: `falha ao iniciar claude: ${err.message}` }))
  claude.on('close', (code, signal) => {
    errLog.end()
    const exitCode = code ?? (signal ? 128 : null)
    if (cancelled) return finish({ status: 'cancelled', exitCode })
    if (resultSeen && !resultSeen.is_error && code === 0) return finish({ status: 'done', exitCode })
    const why =
      (resultSeen && resultSeen.is_error && (resultSeen.result || resultSeen.subtype)) ||
      stderrTail.trim().split('\n').slice(-3).join(' | ') ||
      `claude saiu com código ${code}${signal ? ` (sinal ${signal})` : ''}`
    finish({ status: 'error', exitCode, error: String(why).slice(0, 1000) })
  })
}

try {
  main()
} catch (err) {
  finish({ status: 'error', error: `runner: ${err?.message || err}` })
}
