import { invoke, onMain } from './ipc'

// Tipos + wrappers do domínio "ops" (src/main/ipc/ops.ts). Os tipos daqui são
// a fonte de verdade: o main os importa com `import type` (apagado no build).
// Canais com contrato compartilhado (usados por outros painéis — não mudar):
//   ops:ports, ops:screenshot, ops:repos, ops:open.

// ─── contratos compartilhados ───────────────────────────────────────────────
export interface PortRow {
  port: number
  pid: number
  command: string
  address: string
  user?: string
}

export interface RepoRow {
  path: string
  name: string
  branch?: string
  dirty: number
  ahead?: number
  behind?: number
  /** "<quando> · <assunto>" do último commit */
  lastCommit?: string
}

export interface OpenTarget {
  kind: 'finder' | 'vscode' | 'terminal' | 'url'
  path?: string
  url?: string
}

export interface Screenshot {
  dataUrl: string
}

// ─── demais canais ops:* ────────────────────────────────────────────────────
export type KillSignal = 'SIGTERM' | 'SIGINT' | 'SIGKILL'

export interface ProcRow {
  pid: number
  ppid: number
  user: string
  cpu: number
  mem: number
  /** KiB residentes */
  rssKb: number
  elapsed: string
  name: string
  args: string
  /** categoria heurística: node, python, hermes, claude, ollama, docker, dev */
  kind: string
  /** processo do próprio app (ou filho dele, ex.: hermes serve do cockpit) */
  own: boolean
}

export interface AppRow {
  name: string
  pid?: number
}

export interface AppsResult {
  apps: AppRow[]
  error?: string
}

export interface RepoBranch {
  name: string
  upstream?: string
  current: boolean
  when?: string
}

export interface RepoWorktree {
  path: string
  branch?: string
  head?: string
  bare?: boolean
}

export interface RepoCommit {
  hash: string
  subject: string
  when: string
  author: string
}

export interface RepoDetail {
  path: string
  branches: RepoBranch[]
  remotes: { name: string; url: string }[]
  worktrees: RepoWorktree[]
  commits: RepoCommit[]
  status: string[]
}

export interface ContainerRow {
  id: string
  name: string
  image: string
  state: string
  status: string
  ports: string
  created?: string
}

export type ContainersResult =
  | { daemon: true; containers: ContainerRow[] }
  | { daemon: false; installed: boolean; error: string }

export type ContainerAction = 'start' | 'stop' | 'restart' | 'rm' | 'logs'

export interface OllamaModel {
  name: string
  size: number
  family?: string
  parameterSize?: string
  quantization?: string
  contextLength?: number
  capabilities?: string[]
  modifiedAt?: string
  /** carregado na memória (api/ps) */
  loaded: boolean
  vram?: number
  expiresAt?: string
}

export type ModelsResult =
  | { running: true; version?: string; models: OllamaModel[]; pulling: string[] }
  | { running: false; installed: boolean; error: string; models: []; pulling: string[] }

export interface PullProgress {
  name: string
  status: string
  completed?: number
  total?: number
  done?: boolean
  error?: string
}

export interface SystemInfo {
  cpuPct: number
  cores: number
  load: [number, number, number]
  memTotal: number
  memUsed: number
  diskTotal: number
  diskFree: number
  uptimeSec: number
  hostname: string
  osVersion: string
}

// ─── wrappers ───────────────────────────────────────────────────────────────
export const ops = {
  ports: () => invoke<PortRow[]>('ops:ports'),
  kill: (pid: number, signal?: KillSignal) => invoke<void>('ops:kill', pid, signal),
  processes: () => invoke<ProcRow[]>('ops:processes'),
  apps: () => invoke<AppsResult>('ops:apps'),
  quitApp: (name: string) => invoke<void>('ops:quitApp', name),
  repos: (force = false) => invoke<RepoRow[]>('ops:repos', { force }),
  repo: (path: string) => invoke<RepoDetail>('ops:repo', path),
  open: (target: OpenTarget) => invoke<void>('ops:open', target),
  containers: () => invoke<ContainersResult>('ops:containers'),
  container: (action: ContainerAction, id: string) => invoke<string | void>('ops:container', action, id),
  models: () => invoke<ModelsResult>('ops:models'),
  modelPull: (name: string) => invoke<void>('ops:modelPull', name),
  modelPullCancel: (name: string) => invoke<void>('ops:modelPullCancel', name),
  modelRm: (name: string) => invoke<void>('ops:modelRm', name),
  modelUnload: (name: string) => invoke<void>('ops:modelUnload', name),
  screenshot: () => invoke<Screenshot>('ops:screenshot'),
  system: () => invoke<SystemInfo>('ops:system'),
  onPullProgress: (fn: (p: PullProgress) => void) => onMain<PullProgress>('ops:pull-progress', fn),
}

// ─── formatação ─────────────────────────────────────────────────────────────
export function fmtBytes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

export function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  // ipcRenderer.invoke prefixa "Error invoking remote method 'x': Error: ..."
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
