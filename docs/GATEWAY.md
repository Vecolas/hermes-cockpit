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
