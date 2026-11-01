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
  // extras gravados pelo runner (implementação):
  isolation?: 'worktree' | 'none' // 'none' = rodou direto no cwd (não-git ou repo sem commits)
  note?: string           // motivo de isolation 'none'
  repoRoot?: string       // toplevel git do repo pedido
  worktree?: string       // raiz do worktree (cwd pode ser subdir se o pedido era subdir do repo)
  baseCommit?: string     // HEAD do repo quando o worktree foi criado (base do diffStat)
  parentRunId?: string    // continuação (swarm:send / claude_send)
  resumeSessionId?: string
}
interface Approval {
  id: string; runId: string
  toolName: string; input: unknown
  status: 'pending' | 'allow' | 'deny'
  createdAt: string; decidedAt?: string; reason?: string
  /** só para allow: input possivelmente editado devolvido ao claude */
  updatedInput?: unknown
  toolUseId?: string
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

## Implementação (2026-11-01)

Arquivos em `swarm/` (copiados para `~/.hermes/cockpit/swarm-bin/` por `npm run swarm:install`):

| arquivo | papel |
|---|---|
| `run.mjs <runId>` | runner detached de uma run |
| `server.mjs` | MCP `claude_swarm` para os bots |
| `perm.mjs` | MCP `cockpit_perm` (permission-prompt-tool) |
| `cli.mjs` | `spawn '<json>' \| send <runId> <msg> \| cleanup <runId> \| cancel <runId> \| version` → 1 linha JSON `{ok,data\|error}`; usado pelo main do cockpit |
| `install.mjs` | instala (idempotente) + registra `claude_swarm` nos profiles (`--profiles a,b`, `--no-profiles`) |
| `lib/state.mjs`, `lib/runs.mjs`, `lib/mcp.mjs` | estado em disco, operações, servidor MCP stdio mínimo |

Decisões:

- **Worktrees** em `~/.hermes/cockpit/worktrees/<repo>-<runId>` (centralizado; não suja o
  diretório pai dos repos), branch `hermes/<runId>` a partir do HEAD. Nada é commitado
  pelo runner: as mudanças ficam no worktree; `claude_result.diffStat` = `git diff --stat
  baseCommit` + arquivos untracked. cwd não-git ou repo sem commits → roda direto no cwd,
  `isolation:'none'` + `note` (aí Edit/Write NÃO são pré-aprovados: viram card). cwd é
  validado com realpath e recusado se for HOME, `/`, diretório de sistema ou de
  config/segredos (`~/.ssh`, `~/.config`, `~/Library`, ...). `swarm:cleanup` remove a RAIZ do
  worktree (`meta.worktree`, não o subdir em `cwd`) e recusa se outra run ativa usa o mesmo
  worktree; a limpeza em massa do Storage só pega worktrees LIMPOS (sem mudanças não
  commitadas) e nunca usa `--force`.
- **Continuação** (`send`): nova run com `parentRunId`, mesmo cwd/branch, `--resume
  <claudeSessionId>`; só para runs terminadas.
- **Escritor único de meta.json** = o runner. `createRun` grava a meta `queued` e spawna;
  o runner regrava com `pid`/`running`. `perm.mjs` NÃO toca a meta: o runner observa
  `approvals/` (poll 500ms) e alterna `running` ⇄ `waiting_approval`. Exceção: cancelar uma
  run cujo runner já morreu grava `cancelled` direto.
- **Status derivado na leitura** (sem reescrever disco): run não-terminal com runner morto →
  `error` "runner encerrou sem finalizar"; `queued` há > 60s → `error` "runner não iniciou".
- **Comando claude** (2.1.316): `claude -p --output-format stream-json --verbose
  --allowedTools Read,Glob,Grep,LS[,Edit(//<worktree>/**),Write(//<worktree>/**),...]
  --mcp-config runs/<id>/mcp.json --strict-mcp-config --permission-prompt-tool
  mcp__cockpit_perm__approve --setting-sources= [--model X] [--resume S] -- <task>`. `--`
  protege a task das flags variádicas. Edição só é pré-aprovada dentro do worktree (regra
  com caminho absoluto). `--setting-sources=` (vazio) não carrega NENHUMA fonte: nem
  plugins/hooks do `~/.claude` (contexto enxuto; tarefa trivial com haiku ~$0.002), nem o
  `.claude/settings.json` commitado no repo — um `permissions.allow`/`defaultMode` ali
  pularia o card de aprovação. `SWARM_SETTING_SOURCES=user,local` (ou `all` = user,local)
  no ambiente do runner reativa essas fontes; `project` nunca é aceito.
- **Ambiente**: o claude precisa de `USER`/`LOGNAME` para achar a credencial no Keychain
  (sem eles: "Not logged in"); o spawner garante. Remove `CLAUDECODE`, `CLAUDE_CODE_*` e
  `ELECTRON_RUN_AS_NODE` herdados. Binários por caminhos conhecidos (`~/.local/bin`,
  `/opt/homebrew/bin`, `/usr/local/bin`, PATH); overrides `CLAUDE_BIN`, `HERMES_SWARM_DIR`,
  `HERMES_SWARM_WORKTREES` (testes), `SWARM_APPROVAL_TIMEOUT_MS`.
- **Cancelamento**: SIGTERM no runner → SIGTERM no grupo do claude (spawn detached), SIGKILL
  após 5s; status `cancelled`; aprovações pendentes da run viram `deny` "run terminou".
- **Permissões, atenção**: o Claude Code aprova sozinho comandos Bash que classifica como
  somente-leitura (`echo`, `ls`, `cat`...) sem chamar o permission-prompt-tool — eles não
  geram card. Comandos que escrevem (`touch`, `rm`, `npm`...) geram.
- **MCP**: JSON-RPC por linha; ecoa `protocolVersion` do cliente se for 2024-11-05,
  2025-03-26, 2025-06-18 ou 2025-11-25 (o Hermes pede 2025-03-26), senão 2025-06-18.
- **Registro no Hermes** (`mcp_servers` de chief, mercurio, atlas, hefesto, kairos; backup
  `config.yaml.bak-20261101`):
  ```yaml
  mcp_servers:
    claude_swarm:
      command: "/Users/alexandre/.local/bin/node"
      args: ["/Users/alexandre/.hermes/cockpit/swarm-bin/server.mjs"]
      env:
        SWARM_PROFILE: "chief"   # vira requestedBy.profile
      connect_timeout: 30
      timeout: 120
  ```
  O Hermes filtra o env dos servidores stdio (PATH, HOME, USER, LANG...), por isso o profile
  vai explícito em `SWARM_PROFILE`. Processos Hermes já rodando precisam recarregar a config.
- **IPC extra**: `swarm:decide` aceita 4º arg opcional `updatedInput`; `swarm:status`
  também devolve `stateDir` e `error?`; `swarm:decide` em aprovação já decidida lança erro.
