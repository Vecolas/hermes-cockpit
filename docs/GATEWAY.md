# Gateway JSON-RPC — mapeamento usado pelo chat do cockpit

Fonte de verdade: `~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json`
(gera `gateway-contract.generated.ts`). Wrappers tipados: `src/renderer/src/lib/gateway.ts`.
Validado contra `hermes serve` real em 2026-11-01 com `scripts/smoke-chat.mjs`.

## Envelope

| Direção | Forma |
|---|---|
| cliente → servidor (call) | `{jsonrpc:"2.0", id, method, params}` → resposta `{id, result}` ou `{id, error:{code,message}}` |
| servidor → cliente (notificação) | `{jsonrpc:"2.0", method:"event", params:{type, session_id?, payload?, seq?}}` |
| servidor → cliente (server request) | `{jsonrpc:"2.0", id:"srq-<hex>", method:"approval"\|"clarify"\|…, params:{session_id, …}}` — o cliente responde `{id, result}` |

`session_id` dos eventos é o id **runtime** da sessão (o mesmo que `prompt.submit` usa), não o id armazenado.
`seq` é um contador monotônico por sessão (replay após reconexão).

## Métodos usados pelo ChatPane

| Função (`lib/gateway.ts`) | Método | Params reais | Observações |
|---|---|---|---|
| `findBotChat` | `session.list` | `{profile, title:"Bot Chat", limit:200, include_hidden:true}` | Busca indexada por título. Falha de RPC lança (falha fechada, nunca cria). |
| `resolveBotChat` | `session.list` → `session.create` → `session.title` | create: `{profile, title:"Bot Chat", hidden:true, follow_profile_config:true}`; title: `{session_id:<runtime>, profile, title:"Bot Chat"}` | Só cria se o registro estiver vazio **e** `profiles.list` não reportar `canonical_session`. Conflito "already in use" → readota o vencedor. Sem kickoff. |
| `resumeSession` | `session.resume` | `{session_id:<stored ou resolved_id>, profile}` | Devolve `session_id` runtime, `messages`, `info`, `running`, `inflight`, `pending_approval`, `open_requests`. ~90 ms para o Bot Chat do chief (41 msgs). |
| `listSessions` | `session.list` | `{profile, limit}` | Side-chats (o Bot Chat é hidden e não aparece). |
| `createSideChat` | `session.create` | `{profile, follow_profile_config:true}` | Lazy: a linha no DB só nasce no 1º prompt (não dá para `session.resume` antes). |
| `loadHistory` | `session.history` | `{session_id:<runtime>, profile?}` | O resume já traz `messages`; usado como alternativa. |
| `submitPrompt` | `prompt.submit` | `{session_id:<runtime>, text}` | Resultado `{status:"streaming"\|"queued"\|"steered"\|"redirected"}`; o texto chega por eventos. |
| `interruptTurn` | `session.interrupt` | `{session_id:<runtime>}` | Turno termina com `message.complete {status:"interrupted"}`. |
| `respondApproval` | `approval.respond` | `{session_id, choice, request_id?}` | Só para aprovações restauradas (`pending_approval`) sem server request vivo. |
| — | `approval.pending` | `{session_id}` | Reconciliação de cards quando chega `request.cancel`. |
| `commandsCatalog` | `commands.catalog` | `{profile?, session_id?}` | `{pairs:[["/cmd","desc"]], categories:[{name,pairs}], skills:{nome:{usage,origin}}, skill_count, sub, canon, commands, warning}` — chief: 107 pares, 11 skills. |
| `execSlash` | `slash.exec` | `{session_id, command:"cmd args"}` (sem a barra) | `{output, warning}` ou diretiva `{type: exec\|alias\|plugin\|send\|skill\|prefill, …}`. |
| `commandDispatch` | `command.dispatch` | `{session_id, name, arg}` | Fallback quando `slash.exec` falha (mesmo fluxo do desktop oficial). |
| `getProfileModel` | `profiles.list` + `config.get` | `{}` / `{profile, key:"full"}` | Modelo/provider vêm do `ProfileRow`; fallback de `config.fallback_model` (dict ou lista). Só esse campo é retido. `config.get {key:"provider"}` devolve `provider:"unknown"` para o chief — não usar. |
| `modelOptions` | `model.options` | `{profile, session_id?}` | `{providers:[{slug,name,models[],authenticated,…}], model, provider}`. |
| `switchModel` | `config.set` | `{session_id, profile, key:"model", value:"<model> --provider <slug> --global\|--session", confirm_expensive_model?}` | **Exige sessão viva** (sem sessão → erro 4001). `--global` grava o default do profile; `--session` vale só para a sessão (o Bot Chat usa `follow_profile_config`, então uma troca `--session` pode não sobreviver a um resume). Resposta pode trazer `confirm_required` + `confirm_message` (reenviar com `confirm_expensive_model:true`) ou `deferred` (aplica no próximo turno). |

## Aprovações — mecanismo real

São **server requests** `approval` (não evento + método). Ver `tui_gateway/server_requests.py` e
`server.py::_emit_approval_request`:

1. O backend envia `{id:"srq-…", method:"approval", params:{session_id, request_id, command, description, choices:["once","session","always","deny"], tool_name, allow_session, allow_permanent, smart_denied}}`.
2. O cliente responde o frame com `result:{choice}` (`ApprovalResult`; `all:true` opcional). No cockpit:
   `rpc.setRequestHandler` devolve uma Promise que o card resolve com `{choice}` em Aprovar/Negar.
3. Se a aprovação se resolve por outro caminho (timeout, interrupt, outra superfície), chega
   `event request.cancel {id, method, reason}`. Como o handler não recebe o `id` JSON-RPC, o
   ChatPane reconcilia via `approval.pending {session_id}` e remove os cards mortos.
4. Reconexão: `session.resume` traz `open_requests` (o `HermesRpc` re-entrega ao handler) e
   `pending_approval` (respondido via `approval.respond`).

Outros server requests (`clarify`, `sudo`, `secret`, `vault.*`, `preview.*`, `terminal.read`, `tour`)
ainda não são suportados: o handler lança e o cliente responde erro `-32000`.

## Eventos observados (prompt "responda só: ok" ao chief, kimi-coding/k3.1-pro)

Ordem e contagem na sessão do turno:

| Evento | Qtde | Payload |
|---|---|---|
| `session.info` | 1 | `SessionLiveInfo` (model, provider, approval_mode, running, title, stored_session_id, usage, …) |
| `message.start` | 1 | `{}` |
| `session.title` | 2 | `{session_id, title}` (auto-titler) |
| `thinking.delta` | 3 | `{text}` |
| `reasoning.delta` | 81 | `{text, verbose}` |
| `message.delta` | 1 | `{text}` — texto incremental da resposta (aqui um único chunk "ok") |
| `session.usage` | 1 | `{usage}` |
| `reasoning.available` | 1 | `{text, verbose}` |
| `message.complete` | 1 | `{text:"ok", usage, status:"complete", reasoning}` |

Sem `session_id` (broadcast): `gateway.ready` (1º frame da conexão), `sessions.changed`.
Nenhum server request nesse turno.

Também tratados pelo reducer (`lib/chat-store.ts`), conforme o contrato: `message.interim`
(`{text, already_streamed}`), `tool.generating` (`{name}`), `tool.start`
(`{tool_id, name, context, args, args_text, preview}`), `tool.complete`
(`{tool_id, name, summary, result_text, duration_s, args, inline_diff}`), `status.update`
(`{kind, text}`), `error` (`{message}`), `notice` (`{message}`), `request.cancel`.

## Observações

- `session.create` devolve `info.model` provisório (ex.: `hermes3:8b`) antes do agente ser
  construído — o chip de modelo usa o `ProfileRow` do `profiles.list`, não esse campo.
- Origin: o WS de `hermes serve` só aceita origens `http(s)://localhost|127.0.0.1`; um cliente
  Node sem header Origin conecta normalmente (smoke).

## Gestão de sessões (abas, gaveta, Armazenamento) — validado 2026-11-01

RPC e REST misturados de propósito: cada operação vai onde o backend é dono do caso.

| Função (`lib/gateway.ts`) | Transporte | Contrato | Observações |
|---|---|---|---|
| `listSessionsAll` | `session.list` | `{profile, limit, include_hidden?}` | Sem `include_hidden` o backend omite ocultas; a gaveta faz as duas chamadas para marcar "oculta". O Bot Chat é filtrado sempre. |
| `searchSessions` | `GET /api/sessions/search?q&limit&profile` | `{results:[{session_id, id, title, snippet, started_at, message_count, …}]}` | FTS com prefixo; `snippet` vem com marcadores `>>>`/`<<<` (removidos na UI). Fallback local por título se o REST falhar. |
| `renameSession` | `session.title` (sessão VIVA) ou `PATCH /api/sessions/{id}` `{title, profile}` | `session.title` é `session_scoped` → 4001 para id que não está vivo | Recusa `"Bot Chat"` (identidade do canônico). Em side-chat fresh (sem linha), `session.title` materializa a linha. |
| `setSessionHidden` | `session.set_hidden` | `{session_id:<runtime ou stored>, hidden, profile}` | → `{hidden, session_key}`; id desconhecido → 4001. |
| `deleteSessionRpc` | `session.delete` | `{session_id:<stored>, profile}` | Recusa sessão viva (4023 "cannot delete an active session"); inexistente → 4007. A gaveta: se 4023 e fomos nós que abrimos (sem turno), `session.close` no runtime e tenta de novo. **Não** usamos `DELETE /api/sessions/{id}` aqui (apaga mesmo com agente vivo). |
| `closeSession` | `session.close` | `{session_id:<runtime>}` | Teardown do runtime (`end_reason=tui_close`); registro intacto. Usado ao fechar aba sem turno rodando. |
| `exportSession` | `GET /api/sessions/{id}/export?profile` | JSON `{…linha da sessão, messages:[…]}` (stream) | Baixado como `hermes-<profile>-<id>.json`. |
| `restSessions` | `GET /api/sessions?profile&limit≤100&offset&archived=include&order=recent` | `{sessions, total, limit, offset}` | **Ocultas ficam de fora** (o Bot Chat não aparece — `total` conta ele). Linhas trazem `last_active`, `is_active` (ended_at nulo + atividade < janela), tokens. |
| `bulkDeleteSessions` | `POST /api/sessions/bulk-delete` `{ids≤500, profile}` | `{ok, deleted}` | Apaga inclusive ativas/arquivadas → o StoragePanel bloqueia `is_active` e "Bot Chat" na seleção. |
| `sessionStats` / `emptySessionCount` / `deleteEmptySessions` | `GET /api/sessions/stats`, `GET /api/sessions/empty/count`, `DELETE /api/sessions/empty` (todos `?profile`) | stats: `{total, active_store, archived, messages, by_source}` | "Vazia" = sem nenhuma linha em `messages`; ativas e arquivadas são puladas pelo backend. |
| `modelInfo` | `GET /api/model/info?profile` | `{model, provider, effective_context_length, …}` | Contexto só do modelo configurado do profile (model.options não traz contexto por modelo). |
| `setProfileDefaultModel` | `PUT /api/profiles/{name}/model` `{provider, model}` | `{ok}` | Grava o config.yaml **do profile** (não o do serve). Sem guarda de modelo caro — por isso o picker faz antes o `config.set --session` (que tem a guarda). |

### Abas do chat

- Bot Chat canônico sempre fixo na 1ª aba; nunca persistido (regra Bot Mode).
- `localStorage["hermes-cockpit.chat.tabs.<profile>"]` = **só** os ids armazenados dos side-chats abertos, na ordem da faixa. Side-chat recém-criado (lazy, sem linha no DB) só entra depois do 1º prompt ou de um renomear.
- Uma sessão resumida por vez (a aba ativa); abas em 2º plano continuam recebendo `message.start`/`message.complete` → ponto pulsante na aba.
- `session.title` (evento do auto-titler: `session_id` runtime, `payload.title`) atualiza o título da aba.

### Seletor de modelo — escopo (resolve a pendência da rodada anterior)

- **este chat**: `config.set {session_id, profile, key:"model", value:"<m> --provider <p> --session"}`. No Bot Chat (`follow_profile_config`) vale até o próximo resume — a UI avisa.
- **padrão do bot**: o mesmo `--session` na sessão viva (troca já + guarda de modelo caro) e depois `PUT /api/profiles/<bot>/model`. Não usamos mais `--global`: ele grava no profile da sessão (`_session_profile_runtime_scope`) e exige sessão viva (sem sessão → 4001); o `PUT` nomeia o profile explicitamente e funciona mesmo sem chat aberto.
- Providers com `authenticated:false` e qualquer slug `*codex*` ficam fora da lista (o usuário não usa Codex).
- `model.options {profile, session_id?, refresh?}` → por provider: `models[]`, `capabilities{model:{reasoning,fast}}`, `pricing{model:{input,output,free}}` (quando houver), `api_url` (local = localhost/127.0.0.1 ou slug ollama/lmstudio/…), `warning`, `unavailable_models`. Chief (2026-11-01): moa, anthropic(17), copilot(44), gemini(17), kimi-coding(13, atual), opencode-free(7), ollama(18, local) — `pricing` veio vazio para todos.

### Armazenamento em disco (main, `src/main/ipc/storage.ts`)

`storage:usage` → `{root, totalKb, categories:[{id,label,group,kb,paths,clean?,note?}], errors, at}` (du -sk; total de `~/.hermes` em chamada própria do du para não descontar inodes já contados).
`storage:preview(kind)` → `{kind, candidates:[{path,kb,reason}], totalKb, rules}`; `storage:clean(kind)` → `{kind, removed, freedKb, errors}`. `kind ∈ logs | cache | worktrees`:
- logs: `*.log.N` ou parados ≥14 dias; nunca modificados nas últimas 24h; `~/.hermes/logs` e `profiles/*/logs`.
- cache: arquivos ≥3 dias em `cache/{audio,images,screenshots,videos,documents,spillover,terminal-output,web,vision,browser-use,exec,delegation}` e `audio_cache`/`image_cache` (raiz e profiles). Catálogos JSON do topo de `cache/` ficam.
- worktrees: runs do swarm em status terminal, runner morto, sem run ativa no mesmo cwd, cwd dentro de `~/.hermes/cockpit/worktrees` → `git worktree remove --force` (branch preservada).
Sessões e `state.db` nunca são tocados por aqui.
