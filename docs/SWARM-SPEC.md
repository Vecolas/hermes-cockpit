# Swarm de Claude Code — contrato

Hermes (bots chief, mercurio, atlas, hefesto, kairos) delega tarefas a instâncias
headless do Claude Code (`claude -p`). O cockpit visualiza e aprova. Três peças:

1. **runner** (`swarm/run.mjs`, Node ESM puro, sem deps): processo *detached*, um por
   run. Cria o git worktree, spawna `claude`, grava estado e eventos, sobrevive a
   restart do Hermes/cockpit.
2. **servidor MCP** (`swarm/server.mjs`, stdio, sem deps): ferramentas para os bots
   do Hermes. Spawna runners. Registrado em `mcp_servers` dos 5 profiles.
3. **servidor de permissão** (`swarm/perm.mjs`, stdio MCP, sem deps): passado ao
   `claude` via `--mcp-config` + `--permission-prompt-tool mcp__cockpit_perm__approve`.
   Cada pedido de permissão vira um arquivo de aprovação e espera a decisão do cockpit.

Instalados em `~/.hermes/cockpit/swarm-bin/` por `npm run swarm:install` (caminho estável,
independe de onde o app empacotado vive). Hermes e o main do cockpit usam esse caminho.

## Estado em disco — `~/.hermes/cockpit/swarm/`

```
runs/<runId>/meta.json        RunMeta (reescrito atomicamente: write tmp + rename)
runs/<runId>/events.jsonl     uma linha por evento: {"ts": ISO, "ev": <linha stream-json do claude>}
runs/<runId>/stderr.log
approvals/<approvalId>.json   Approval (perm.mjs cria; cockpit decide reescrevendo status)
```

`runId`: `r-<yyyymmdd-hhmmss>-<4 hex>`. `groupId` agrupa runs de um multi-task.

```ts
type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'done' | 'error' | 'cancelled'
interface RunMeta {
  id: string; groupId?: string; title: string; task: string
  repo: string            // repo de origem (cwd pedido)
  cwd: string             // worktree efetivo
  branch?: string         // branch do worktree (hermes/<runId>)
  model?: string
  status: RunStatus
  pid?: number            // pid do runner
  claudePid?: number
  claudeSessionId?: string
  requestedBy?: { profile?: string; sessionId?: string; via: 'mcp' | 'cockpit' }
  createdAt: string; startedAt?: string; endedAt?: string
  numTurns?: number; costUsd?: number; durationMs?: number
  resultText?: string     // texto final (evento result)
  error?: string
  exitCode?: number
}
interface Approval {
  id: string; runId: string
  toolName: string; input: unknown
  status: 'pending' | 'allow' | 'deny'
  createdAt: string; decidedAt?: string; reason?: string
  /** só para allow: input possivelmente editado devolvido ao claude */
  updatedInput?: unknown
}
```

Política de permissão (escolha do usuário: worktree + aprovação na UI): edições de
arquivo dentro do worktree (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) e leitura
(`Read`, `Glob`, `Grep`, `LS`) são liberadas por `--allowedTools`; todo o resto
(Bash, WebFetch, MCP externos...) passa pelo `perm.mjs` → card no cockpit.
Timeout de aprovação: 30 min → deny com motivo.

## IPC no cockpit (domínio `swarm`, src/main/ipc/swarm.ts)

| canal | args | retorno |
|---|---|---|
| `swarm:list` | `{limit?}` | `RunMeta[]` (mais recentes primeiro) |
| `swarm:events` | `runId, fromLine` | `{ lines: {ts, ev}[], next: number }` |
| `swarm:approvals` | — | `Approval[]` pendentes |
| `swarm:decide` | `approvalId, 'allow'\|'deny', reason?` | `void` |
| `swarm:cancel` | `runId` | `void` (SIGTERM no runner → mata o claude, status cancelled) |
| `swarm:spawn` | `{task, cwd, title?, model?, groupId?}` | `RunMeta` |
| `swarm:send` | `runId, message` | `RunMeta` (nova run com `--resume claudeSessionId` no mesmo worktree) |
| `swarm:cleanup` | `runId` | `void` (remove worktree + branch se run terminou) |
| `swarm:status` | — | `{ installed: boolean, binDir, claudeVersion?, profilesRegistered: string[] }` |

Eventos main→renderer: `swarm:changed` `{runId?}` (fs.watch em runs/ e approvals/,
com debounce ~150ms). A UI recarrega lista/eventos/aprovações a partir dele.

## Ferramentas MCP para os bots (server.mjs)

- `claude_spawn {task, cwd, title?, model?}` → `{runId, status}`
- `claude_spawn_many {tasks: [{task, cwd?, title?}], cwd?, model?}` → `{groupId, runIds}`
- `claude_status {runId? | groupId?}` → resumo(s) RunMeta
- `claude_result {runId}` → `{status, resultText, branch, cwd, diffStat}`
- `claude_send {runId, message}` → continua a conversa (resume) → `{runId}`
- `claude_cancel {runId}`
- `claude_list {limit?}`

Hermes também tem subagents nativos (`subagent.list|tail|steer|interrupt`,
`delegation.status`, `spawn_tree.*` no RPC) — a UI do swarm mostra os dois mundos.
