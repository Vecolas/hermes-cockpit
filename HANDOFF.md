# HANDOFF — Hermes Cockpit (delegação para Claude Code)

> Documento de continuidade. O projeto está funcional e empacotado; este arquivo
> contém todo o contexto necessário para implementar as próximas etapas sem
> redescobrir nada. Leia inteiro antes de codar.

## 1. O que é

App desktop local (Electron 40 + React 19 + Vite 8 + Tailwind 4) que serve de
**cockpit de comando para o Hermes Agent** do Alexandre. Não modifica o Hermes:
consome o backend `hermes serve` (JSON-RPC/WS + REST) e o plugin cockpit dele
(`~/.hermes/plugins/cockpit`, FastAPI). Wireframe de referência: cockpit com
rail de bots, chat central, dock lateral (Terminal/Diff/Preview/Arquivos) e
strip de status — tudo redimensionável, modular e customizável.

- **Projeto:** `/Users/alexandre/dev/hermes-cockpit`
- **Hermes (código-fonte do backend e do app oficial):** `/Users/alexandre/.hermes/hermes-agent`
  — LEITURA APENAS. É um managed install; `hermes update` sobrescreve. Nunca
  editar nada ali; usar como referência de contrato e de implementação.
- **Plugin cockpit (dados dos painéis):** `/Users/alexandre/.hermes/plugins/cockpit/dashboard/plugin_api.py`
  — rotas REST `/api/plugins/cockpit/{foco,agenda,notion,sistema,bots,quota,inbox}`.

## 2. Estado atual (validado em 2026-11-01)

Funciona e está empacotado (`release/Hermes Cockpit-0.1.0-arm64.dmg`, Electron 40.10.2, arm64, sem assinatura):

- Main process spawna `hermes serve --host 127.0.0.1 --port 0`, captura a porta
  do sentinel `HERMES_(BACKEND|DASHBOARD)_READY port=N` (buffer merged
  stdout+stderr) e injeta token via env `HERMES_DASHBOARD_SESSION_TOKEN`.
  Backend morre com o app (`will-quit` → `stopBackend`).
- REST via proxy IPC no main (`hermes:api`) — resolve CORS e mantém o token
  fora do renderer. Strip inferior (foco/cota/inbox) já renderiza dados reais.
- Cliente JSON-RPC mínimo no renderer (`src/renderer/src/lib/rpc.ts`).
- Smoke tests passaram: REST `/api/plugins/cockpit/bots` → 200 com dados reais;
  WS `/api/ws?token=` + `profiles.list` → 9 profiles reais.

**Bug aberto nº 1 (rail vazia no app empacotado):** o `serve` valida Origin do
WebSocket e só aceita `https?://(localhost|127.0.0.1)` — ver
`hermes_cli/web_server.py` (~linha 386 e ~449). O renderer empacotado roda em
`file://` → WS fechado (badge "fechado", rail mostra "nenhum profile
retornado"). **Correção definida: proxy do WS pelo main process** (ver §5, P0-1).

## 3. Gotchas críticos (todos morderam; não repita a investigação)

1. **`ELECTRON_RUN_AS_NODE=1` pode estar no ambiente do shell** (alguns hosts
   Electron a exportam). Com ela, qualquer binário Electron vira Node puro e o
   app morre com `The requested module 'electron' does not provide an export
   named ...`. Sintoma falso de "bug no código". Para rodar de shells afetados:
   `env -u ELECTRON_RUN_AS_NODE npm run dev`. A variável NÃO existe no launchd
   do macOS — app aberto pelo Finder é imune. O main já faz
   `delete env.ELECTRON_RUN_AS_NODE` para os filhos (`src/main/backend.ts::childEnv`).
2. **Testes de GUI só valem com GUI de verdade.** Shells de agentes/daemon não
   hospedam o browser process do Electron: o binário roda em modo utilitário
   (`process.type` ausente) e tudo falha como se fosse bug de ESM. Valide com
   `env -u ELECTRON_RUN_AS_NODE open release/mac-arm64/*.app` + `ps aux | grep`.
3. **`npm install` já clobberou o `package.json`** (apagou `scripts` e deps) no
   ambiente original. Depois de qualquer `npm install`, conferir
   `grep -c '"scripts"' package.json`. O conteúdo canônico está no git/atual.
4. **App empacotado (Finder) tem PATH mínimo.** `resolveHermesBin()` em
   `src/main/backend.ts` procura `~/.local/bin/hermes`, `/opt/homebrew/bin`,
   `/usr/local/bin` antes de cair no PATH. Manter isso ao mexer no spawn.
5. **`hermes serve` sobe em ~1–2s** e imprime o sentinel no stdout; não
   reinventar health-check. Timeout atual de 90s é folgado de propósito.
6. **DMG sem assinatura** (`identity: null` de propósito): primeira abertura
   exige botão direito → Abrir.

## 4. Contratos com o backend (fontes de verdade)

| Coisa | Onde está |
|---|---|
| Catálogo completo de métodos RPC + eventos | `~/.hermes/hermes-agent/apps/shared/src/gateway-contract.openrpc.json` (gera `gateway-contract.generated.ts` — dá para copiar/gerar tipos) |
| Cliente oficial de referência (WS, envelope, retry) | `~/.hermes/hermes-agent/apps/shared/src/json-rpc-channel.ts` e `json-rpc-gateway.ts` |
| Envelope | `{jsonrpc:'2.0', id, method, params}`; respostas por `id`; server requests chegam com `id`+`method` (hoje respondemos `-32601`); eventos/notificações com `method` sem `id` |
| WS endpoint | `ws://127.0.0.1:<port>/api/ws?token=<token>` |
| REST | `http://127.0.0.1:<port>/api/...` com header `x-hermes-session-token: <token>` |
| Plugins REST | `/api/plugins/<nome>/<rota>` (mount em `hermes_cli/web_server.py`, ~linha 595) |
| Terminal PTY | WS `/api/pty?token=...`, frames PTY brutos, resize via `\x1b[RESIZE:<cols>;<rows>]` — ver `hermes_cli/pty_bridge.py` e `web/src/pages/ChatPage.tsx` |
| Bot Mode (regra da sessão canônica) | `~/.hermes/hermes-agent/apps/desktop/src/AGENTS.md` § "Bot Mode" — um chat eterno por profile identificado por (profile, sessão intitulada exatamente "Bot Chat"), resolvido via `session.list {title, include_hidden:true}`; NUNCA guardar session-id |
| Aprovações | fluxo via RPC de prompt; ver `tui_gateway/methods_prompt.py` (232 ocorrências de "approv" em tui_gateway) e como o desktop renderiza cards de aprovação |
| Bots do Alexandre | profiles: `chief, mercurio` (coordenação), `atlas, hefesto, kairos` (trabalho), `lar, vesta` (pessoal), `argos` (operações) — mapa em `src/renderer/src/lib/bots.ts`, espelho do `_BOT_GROUPS` do plugin |

## 5. Roadmap (o que falta)

### P0 — Funcional conectado (fazer primeiro, nesta ordem)

1. **Proxy WS pelo main process.** IPC `hermes:ws:open|send|close`; o main abre
   o WebSocket (Node ≥22 tem `WebSocket` nativo — sem dep nova) e retransmite
   frames por `webContents.send`. Renderer mantém a API do `HermesRpc` mas sobre
   um transport IPC. Aceite: rail popula os 8 bots no app empacotado; badge "ws aberto".
2. **Chat com streaming.** Composer ativo; submit no profile selecionado;
   transcript com eventos de turno (texto incremental, spinner de turno, tool
   calls expandíveis, cancelar). Contrato em `gateway-contract.openrpc.json`
   (métodos `prompt.*`/`session.*` e eventos). Aceite: conversar com o chief,
   ver streaming token a token, histórico ao reabrir.
3. **Sessão canônica por bot** (regra do §4/Bot Mode). Clicar no bot abre o
   chat eterno dele; side-chats ficam visíveis numa lista de sessões.
4. **Aprovações.** Handler de server request no transport IPC → card
   Aprovar/Negar → resposta ao backend. Aceite: pedir algo que exija aprovação
   e aprovar pelo card.
5. **Slash commands** — `commands.catalog` (autocomplete) + `slash.exec`.
6. **Model picker por bot** — modelo atual vem no `profiles.list`.

### P1 — Adaptável + modular (fazer junto; se interdependem)

7. **Split panes** com `react-resizable-panels` (rail ↔ chat ↔ dock, alças,
   tamanhos persistidos em localStorage), panes colapsáveis e modo foco.
8. **Registry de painéis** — `{ id, título, componente, fonte, refresh }`;
   layout serializado em JSON; widgets do plugin cockpit (`/foco`, `/quota`,
   `/inbox`, `/notion`, `/sistema`) viram cards encaixáveis em qualquer região.
9. **Responsivo** — breakpoints (rail overlay, dock em abas, strip com scroll);
   corrigir padding da titlebar (`hiddenInset` colide com traffic lights).
10. **Temas** — presets sobre os tokens `@theme` em `src/renderer/src/index.css`
    (grafite/fósforo/âmbar/claro) + overrides de accent/fonte/densidade.
11. **Comandos rápidos por bot** — snippets configuráveis que viram prompt.

### P2 — Resto do wireframe

12. Terminal xterm.js sobre `/api/pty` (aba "Tela Mac"). 13. Diff/Git
(`git_probe` do backend). 14. Preview/screenshot do Mac. 15. Execuções do
swarm (subagents). 16. Busca de sessões.

## 6. Convenções e processo

- TypeScript estrito; `npm run typecheck` deve passar antes de cada entrega.
- Sem dependência nova sem justificar (o projeto é deliberadamente leve).
- Falha de qualquer fonte de dados vira chip/estado de erro no painel — nunca
  derruba a UI (mesmo contrato do plugin cockpit).
- Renderer nunca fala direto com o backend em produção: REST via proxy IPC;
  WS via proxy IPC (após P0-1). Exceção: modo `dev:web` (navegador), degradado.
- Não editar nada em `~/.hermes/hermes-agent` (read-only, managed install).
- Estilo visual: manter a identidade "grafite" (tokens em `index.css`), labels
  uppercase com tracking, accents âmbar/fósforo, scanlines discretas.
- Commits pequenos e temáticos; rebuild da DMG com `npm run dist` ao final de
  cada etapa entregue (usuário instala por DMG).

## 7. Comandos

```bash
cd /Users/alexandre/dev/hermes-cockpit
npm install                                  # depois: grep -c '"scripts"' package.json (gotcha §3.3)
npm run dev                                  # dev (se falhar: env -u ELECTRON_RUN_AS_NODE npm run dev)
npm run typecheck && npm run build
npm run dist                                 # DMG em release/
env -u ELECTRON_RUN_AS_NODE open "release/mac-arm64/Hermes Cockpit.app"   # validar empacotado
ps aux | grep "Hermes Cockpit" | grep -v grep                              # app vivo?
ps aux | grep "serve --host" | grep -v grep                                # backend do app vivo?
```

## 8. Critério de "pronto" do P0

Abrir o app empacotado pelo Finder: rail mostra os 8 bots agrupados; clicar no
chief abre o chat eterno dele; mandar mensagem e ver streaming; receber um
pedido de aprovação e aprovar pelo card; fechar o app mata o `hermes serve`
filho. Sem nada rodando solto (`ps aux | grep` limpo).
