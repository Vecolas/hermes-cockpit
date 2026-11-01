# Hermes Cockpit

Cockpit local para o Hermes Agent — Electron + React + Tailwind, falando com o
`hermes serve` local. Não modifica nada do Hermes: o app spawna o backend
(`hermes serve --host 127.0.0.1 --port 0`), lê a porta do sentinel
`HERMES_BACKEND_READY` e injeta o token de sessão via `HERMES_DASHBOARD_SESSION_TOKEN`.

## Rodar

```bash
npm install
npm run dev        # abre a janela do Electron (renderer também fica acessível no navegador)
npm run dev:web    # só o renderer no navegador (pede URL + token manualmente)
npm run build      # build de produção em out/
npm run typecheck
npm run dist       # gera a DMG em release/ (Electron 40, sem assinatura)
```

**Atenção — `ELECTRON_RUN_AS_NODE`:** se o app falhar com
`The requested module 'electron' does not provide an export named ...`,
o ambiente do seu shell está com essa variável setada (alguns hosts Electron a exportam).
Rode com `env -u ELECTRON_RUN_AS_NODE npm run dev`. A variável não existe no
launchd do macOS, então o app empacotado aberto pelo Finder não é afetado.

A DMG não é assinada: na primeira abertura, clique com o botão direito → Abrir.

## O que já funciona

- **Rail de bots** — `profiles.list` via JSON-RPC (`/api/ws`), agrupado por esquadrão
  (mesmo mapeamento `_BOT_GROUPS` do plugin cockpit).
- **Status strip** — foco/time-boxing, cota R$ e inbox triada via REST do plugin
  cockpit (`/api/plugins/cockpit/{foco,quota,inbox}`), com proxy pelo main process
  (sem CORS, token fora do renderer).
- **Tema grafite** — Tailwind v4, tokens em `src/renderer/src/index.css`.

## Próximas etapas

1. Chat com streaming (`prompt.*` + eventos de turno) contra o profile selecionado.
2. Aba Terminal: xterm.js sobre `/api/pty`.
3. Diff/Git, aprovações (computer use), painel de swarm.

## Estrutura

```
src/main/      processo principal: spawn do serve, proxy REST, janela
src/preload/   contextBridge (window.hermes)
src/renderer/  React: App, components/, lib/ (rpc, connection, bots)
```
