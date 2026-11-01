// Domínio "storage" — uso de disco de ~/.hermes por categoria e limpeza SEGURA.
//
// Canais:
//   storage:usage            → StorageUsage   (du -sk por categoria; diretórios reais descobertos)
//   storage:preview(kind)    → CleanPreview   (o que seria removido, sem tocar em nada)
//   storage:clean(kind)      → CleanResult    (executa a mesma seleção do preview)
//
// Regras de segurança (não negociáveis):
// - NUNCA apaga sessões, state.db, config, skills, memórias, auth, backups.
//   Sessões só pela API do Hermes (StoragePanel → REST/RPC).
// - kind 'logs': só arquivos rotacionados (*.log.N) ou parados há ≥ LOG_MAX_AGE_DAYS,
//   e nunca algo modificado nas últimas 24h, dentro de ~/.hermes/logs e profiles/*/logs.
// - kind 'cache': só arquivos de mídia/transientes com ≥ CACHE_MAX_AGE_DAYS dentro de
//   subpastas conhecidas de cache (os catálogos JSON do topo de cache/ ficam).
// - kind 'worktrees': só worktrees de runs do swarm TERMINADAS (done/error/cancelled),
//   com runner morto, sem run ativa compartilhando o worktree, cuja raiz fica dentro
//   de ~/.hermes/cockpit/worktrees e que estejam LIMPAS (git status --porcelain vazio,
//   sem untracked). Worktree com mudanças não commitadas (o normal de um agente)
//   NUNCA entra: o resultado da run vive só ali. Remove via `git worktree remove`
//   (sem --force); a branch (hermes/<runId>) é PRESERVADA com os commits.
// - Tudo resolvido com realpath e checado contra a raiz permitida (sem seguir symlink
//   para fora).

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { handle } from './index'

const HOME = join(homedir(), '.hermes')
const COCKPIT = join(HOME, 'cockpit')
const SWARM_RUNS = join(process.env.HERMES_SWARM_DIR || join(COCKPIT, 'swarm'), 'runs')
const WORKTREES = process.env.HERMES_SWARM_WORKTREES || join(COCKPIT, 'worktrees')

const LOG_MAX_AGE_DAYS = 14
const CACHE_MAX_AGE_DAYS = 3
const RECENT_GUARD_MS = 24 * 3600_000
const DAY = 24 * 3600_000

/** Subpastas de cache com conteúdo transitório (mídia, saídas, spillover). */
const CACHE_SUBDIRS = [
  'audio',
  'images',
  'screenshots',
  'videos',
  'documents',
  'spillover',
  'terminal-output',
  'web',
  'vision',
  'browser-use',
  'exec',
  'delegation',
]
/** Pastas-irmãs de cache na raiz do HERMES_HOME (e de cada profile). */
const CACHE_ROOT_DIRS = ['audio_cache', 'image_cache']

export type CleanKind = 'logs' | 'cache' | 'worktrees'

export interface UsageCategory {
  id: string
  label: string
  /** grupo para a UI: dados do Hermes, perfis, cockpit, instalação */
  group: 'dados' | 'profiles' | 'cockpit' | 'instalação' | 'outros'
  kb: number
  paths: string[]
  /** limpeza segura disponível para esta categoria */
  clean?: CleanKind
  note?: string
}

export interface StorageUsage {
  root: string
  totalKb: number
  categories: UsageCategory[]
  /** categorias que falharam (du/permite) — nunca derrubam o resto */
  errors: string[]
  at: string
}

export interface CleanCandidate {
  path: string
  kb: number
  reason: string
}

export interface CleanPreview {
  kind: CleanKind
  candidates: CleanCandidate[]
  totalKb: number
  rules: string
}

export interface CleanResult {
  kind: CleanKind
  removed: number
  freedKb: number
  errors: string[]
}

// ── helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0
      resolve({ stdout: String(stdout), stderr: String(stderr), code })
    })
  })
}

/** du -sk em lote; caminhos inexistentes são ignorados. du sai ≠0 em permissão negada
 *  parcial, mas ainda imprime o total — aproveitamos o que vier. */
async function duKb(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const exist = paths.filter((p) => existsSync(p))
  if (!exist.length) return out
  const { stdout } = await run('/usr/bin/du', ['-sk', ...exist], 120_000)
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\d+)\s+(.+)$/)
    if (m) out.set(m[2], Number(m[1]))
  }
  return out
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function profileDirs(): Promise<string[]> {
  const root = join(HOME, 'profiles')
  const names = await listDir(root)
  const out: string[] = []
  for (const n of names.sort()) {
    try {
      if ((await lstat(join(root, n))).isDirectory()) out.push(join(root, n))
    } catch {
      /* corrida com remoção */
    }
  }
  return out
}

/** realpath + checagem de contenção; null se sair da raiz ou não existir. */
async function inside(root: string, p: string): Promise<string | null> {
  try {
    const [r, rp] = await Promise.all([realpath(root), realpath(p)])
    return rp === r || rp.startsWith(r + sep) ? rp : null
  } catch {
    return null
  }
}

async function walkFiles(dir: string, depth = 4): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  const out: { path: string; size: number; mtimeMs: number }[] = []
  const go = async (d: string, left: number) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(d, e.name)
      if (e.isSymbolicLink()) continue // nunca segue link
      if (e.isDirectory()) {
        if (left > 0) await go(p, left - 1)
      } else if (e.isFile()) {
        try {
          const st = await stat(p)
          out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          /* sumiu */
        }
      }
    }
  }
  await go(dir, depth)
  return out
}

const kbOf = (bytes: number) => Math.ceil(bytes / 1024)

// ── uso ──────────────────────────────────────────────────────────────────────

async function usage(): Promise<StorageUsage> {
  const errors: string[] = []
  const profiles = await profileDirs()
  const top = await listDir(HOME)
  const cats: Omit<UsageCategory, 'kb'>[] = []
  const add = (c: Omit<UsageCategory, 'kb'>) => {
    const paths = c.paths.filter((p) => existsSync(p))
    if (paths.length) cats.push({ ...c, paths })
  }

  const stateFiles = top.filter((n) => /^state\.db/.test(n)).map((n) => join(HOME, n))
  add({ id: 'sessions', label: 'Sessões (arquivos)', group: 'dados', paths: [join(HOME, 'sessions')], note: 'apague sessões pela lista abaixo (API do Hermes)' })
  add({ id: 'state', label: 'Banco de sessões (state.db)', group: 'dados', paths: stateFiles, note: 'só via API do Hermes' })
  add({ id: 'logs', label: 'Logs', group: 'dados', paths: [join(HOME, 'logs')], clean: 'logs' })
  add({
    id: 'cache',
    label: 'Caches',
    group: 'dados',
    paths: [join(HOME, 'cache'), ...CACHE_ROOT_DIRS.map((d) => join(HOME, d))],
    clean: 'cache',
  })
  add({ id: 'checkpoints', label: 'Checkpoints', group: 'dados', paths: [join(HOME, 'checkpoints')] })
  add({ id: 'snapshots', label: 'Snapshots de estado', group: 'dados', paths: [join(HOME, 'state-snapshots')], note: 'pré-update; gerencie com hermes' })
  add({ id: 'backups', label: 'Backups', group: 'dados', paths: [join(HOME, 'backups')], note: 'gerencie com hermes backup' })
  add({ id: 'memories', label: 'Memórias / skills / planos', group: 'dados', paths: ['memories', 'skills', 'plans', 'workspace'].map((d) => join(HOME, d)) })
  for (const p of profiles) {
    const name = p.split(sep).pop() as string
    add({ id: `profile:${name}`, label: name, group: 'profiles', paths: [p] })
  }
  add({ id: 'cockpit:swarm', label: 'Swarm (runs e eventos)', group: 'cockpit', paths: [join(COCKPIT, 'swarm')] })
  add({ id: 'cockpit:worktrees', label: 'Worktrees do swarm', group: 'cockpit', paths: [WORKTREES], clean: 'worktrees' })
  add({ id: 'cockpit:bin', label: 'Binários do swarm', group: 'cockpit', paths: [join(COCKPIT, 'swarm-bin')] })
  add({ id: 'agent', label: 'hermes-agent (instalação)', group: 'instalação', paths: [join(HOME, 'hermes-agent')], note: 'managed install — não mexer' })
  add({
    id: 'runtimes',
    label: 'Runtimes (node, runtimes, browser)',
    group: 'instalação',
    paths: ['node', 'runtimes', 'runtime', 'browser-profile', 'bootstrap-cache', 'bin', 'lsp'].map((d) => join(HOME, d)),
  })

  const all = cats.flatMap((c) => c.paths)
  let sizes = new Map<string, number>()
  try {
    // du conta cada inode uma vez por invocação: o total de HOME vai em chamada própria
    const [parts, total] = await Promise.all([duKb(all), duKb([HOME])])
    sizes = parts
    const t = total.get(HOME)
    if (t !== undefined) sizes.set(HOME, t)
  } catch (e) {
    errors.push(`du falhou: ${e instanceof Error ? e.message : String(e)}`)
  }
  const categories: UsageCategory[] = cats.map((c) => ({ ...c, kb: c.paths.reduce((s, p) => s + (sizes.get(p) ?? 0), 0) }))
  const known = categories.reduce((s, c) => s + c.kb, 0)
  const totalKb = sizes.get(HOME) ?? known
  if (totalKb > known) {
    categories.push({ id: 'other', label: 'Outros', group: 'outros', kb: totalKb - known, paths: [HOME], note: 'kanban.db, pets, plugins, vault, etc.' })
  }
  for (const c of categories) if (c.paths.some((p) => !sizes.has(p)) && c.id !== 'other') errors.push(`sem tamanho para ${c.label}`)
  return { root: HOME, totalKb, categories, errors, at: new Date().toISOString() }
}

// ── seleção por kind ─────────────────────────────────────────────────────────

async function logCandidates(): Promise<CleanCandidate[]> {
  const roots = [join(HOME, 'logs'), ...(await profileDirs()).map((p) => join(p, 'logs'))].filter((p) => existsSync(p))
  const now = Date.now()
  const out: CleanCandidate[] = []
  for (const root of roots) {
    for (const f of await walkFiles(root, 3)) {
      if (now - f.mtimeMs < RECENT_GUARD_MS) continue
      const name = f.path.split(sep).pop() ?? ''
      const rotated = /\.log\.\d+(\.gz)?$/.test(name) || /\.\d+\.log$/.test(name)
      const old = now - f.mtimeMs >= LOG_MAX_AGE_DAYS * DAY
      if (!rotated && !old) continue
      if (!(await inside(root, f.path))) continue
      out.push({ path: f.path, kb: kbOf(f.size), reason: rotated ? 'log rotacionado' : `parado há ${Math.floor((now - f.mtimeMs) / DAY)}d` })
    }
  }
  return out
}

async function cacheCandidates(): Promise<CleanCandidate[]> {
  const homes = [HOME, ...(await profileDirs())]
  const roots: string[] = []
  for (const h of homes) {
    for (const d of CACHE_SUBDIRS) roots.push(join(h, 'cache', d))
    for (const d of CACHE_ROOT_DIRS) roots.push(join(h, d))
  }
  const now = Date.now()
  const out: CleanCandidate[] = []
  for (const root of roots.filter((p) => existsSync(p))) {
    for (const f of await walkFiles(root, 4)) {
      const age = now - f.mtimeMs
      if (age < CACHE_MAX_AGE_DAYS * DAY) continue
      if (!(await inside(root, f.path))) continue
      out.push({ path: f.path, kb: kbOf(f.size), reason: `cache de ${Math.floor(age / DAY)}d` })
    }
  }
  return out
}

interface RunMetaLite {
  id?: string
  status?: string
  cwd?: string
  repo?: string
  branch?: string
  pid?: number
  isolation?: string
  worktree?: string
  repoRoot?: string
}

const TERMINAL = new Set(['done', 'error', 'cancelled'])

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function readRuns(): Promise<RunMetaLite[]> {
  const out: RunMetaLite[] = []
  for (const id of await listDir(SWARM_RUNS)) {
    try {
      out.push(JSON.parse(await readFile(join(SWARM_RUNS, id, 'meta.json'), 'utf8')) as RunMetaLite)
    } catch {
      /* run corrompida/parcial: ignora (nunca vira candidata) */
    }
  }
  return out
}

/** Raiz do worktree da run (meta.cwd pode ser um subdiretório dele). */
const wtRoot = (r: RunMetaLite): string | undefined => r.worktree || r.cwd

async function worktreeCandidates(): Promise<(CleanCandidate & { repo: string })[]> {
  if (!existsSync(WORKTREES)) return []
  const runs = await readRuns()
  const wtReal = await realpath(WORKTREES).catch(() => '')
  // worktree em uso por qualquer run não-terminal (ou com runner vivo) fica protegido
  const busy = new Set(
    runs
      .filter((r) => !TERMINAL.has(String(r.status)) || pidAlive(r.pid))
      .map(wtRoot)
      .filter((x): x is string => Boolean(x)),
  )
  const seen = new Set<string>()
  const out: (CleanCandidate & { repo: string })[] = []
  for (const r of runs) {
    const root = wtRoot(r)
    const repo = r.repoRoot || r.repo
    if (!root || !repo || seen.has(root)) continue
    if (!TERMINAL.has(String(r.status)) || pidAlive(r.pid) || busy.has(root)) continue
    if (r.isolation && r.isolation !== 'worktree') continue
    if (!existsSync(root)) continue
    const real = await inside(WORKTREES, root)
    if (!real || real === wtReal) continue
    // Mudanças não commitadas (inclui untracked) = trabalho do agente; nunca limpa.
    const st = await run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], 20_000)
    if (st.code !== 0 || st.stdout.trim()) continue
    seen.add(root)
    out.push({ path: root, repo, kb: 0, reason: `run ${r.id ?? '?'} ${r.status} · worktree limpo${r.branch ? ` · branch ${r.branch} preservada` : ''}` })
  }
  if (out.length) {
    const sizes = await duKb(out.map((c) => c.path))
    for (const c of out) c.kb = sizes.get(c.path) ?? 0
  }
  return out
}

const RULES: Record<CleanKind, string> = {
  logs: `logs rotacionados (*.log.N) ou parados há ≥${LOG_MAX_AGE_DAYS} dias; nada modificado nas últimas 24h`,
  cache: `arquivos com ≥${CACHE_MAX_AGE_DAYS} dias em cache/{${CACHE_SUBDIRS.join(',')}} e ${CACHE_ROOT_DIRS.join(', ')} (catálogos JSON ficam)`,
  worktrees: 'worktrees de runs do swarm terminadas, com runner morto e SEM mudanças não commitadas (os com trabalho pendente ficam); branch preservada',
}

function assertKind(kind: unknown): CleanKind {
  if (kind === 'logs' || kind === 'cache' || kind === 'worktrees') return kind
  throw new Error(`limpeza não permitida: ${String(kind)}`)
}

async function preview(kindRaw: unknown): Promise<CleanPreview> {
  const kind = assertKind(kindRaw)
  const candidates = kind === 'logs' ? await logCandidates() : kind === 'cache' ? await cacheCandidates() : await worktreeCandidates()
  candidates.sort((a, b) => b.kb - a.kb)
  return {
    kind,
    candidates: candidates.map(({ path, kb, reason }) => ({ path, kb, reason })),
    totalKb: candidates.reduce((s, c) => s + c.kb, 0),
    rules: RULES[kind],
  }
}

let cleaning = false

async function clean(kindRaw: unknown): Promise<CleanResult> {
  const kind = assertKind(kindRaw)
  if (cleaning) throw new Error('já existe uma limpeza em andamento')
  cleaning = true
  const errors: string[] = []
  let removed = 0
  let freedKb = 0
  try {
    if (kind === 'worktrees') {
      for (const c of await worktreeCandidates()) {
        // Sem --force: se algo mudou entre a checagem e agora, o git recusa.
        const r = await run('git', ['-C', c.repo, 'worktree', 'remove', c.path], 30_000)
        if (r.code !== 0 || existsSync(c.path)) {
          errors.push(`${c.path}: ${r.stderr.trim().slice(0, 200) || 'git worktree remove falhou'}`)
          continue
        }
        removed++
        freedKb += c.kb
      }
    } else {
      const list = kind === 'logs' ? await logCandidates() : await cacheCandidates()
      for (const c of list) {
        try {
          await unlink(c.path)
          removed++
          freedKb += c.kb
        } catch (e) {
          errors.push(`${c.path}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`)
        }
      }
    }
  } finally {
    cleaning = false
  }
  return { kind, removed, freedKb, errors: errors.slice(0, 50) }
}

export function register(): void {
  handle('storage:usage', () => usage())
  handle('storage:preview', (kind: unknown) => preview(kind))
  handle('storage:clean', (kind: unknown) => clean(kind))
}
