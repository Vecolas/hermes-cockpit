#!/usr/bin/env node
// Servidor MCP "claude_swarm" para os bots do Hermes (stdio, sem deps).
// Registrado em mcp_servers dos profiles por install.mjs. Cada ferramenta
// lê/escreve o estado em ~/.hermes/cockpit/swarm (ver docs/SWARM-SPEC.md).
import { serveMcp } from './lib/mcp.mjs'
import { cancelRun, createRun, result, sendRun, spawnMany, summary } from './lib/runs.mjs'
import { listRuns, readMeta } from './lib/state.mjs'

const requestedBy = () => ({ via: 'mcp', ...(process.env.SWARM_PROFILE ? { profile: process.env.SWARM_PROFILE } : {}) })

const str = (description) => ({ type: 'string', description })

serveMcp({
  name: 'claude_swarm',
  version: '0.1.0',
  instructions:
    'Delegue tarefas de código a instâncias headless do Claude Code. Cada run trabalha num git worktree ' +
    'isolado (branch hermes/<runId>) quando o cwd é um repo git. Leitura/edição de arquivos é livre; ' +
    'Bash e demais ferramentas pedem aprovação do operador no Hermes Cockpit. As ferramentas retornam ' +
    'imediatamente: acompanhe com claude_status e leia o final com claude_result.',
  tools: [
    {
      name: 'claude_spawn',
      description: 'Inicia uma run do Claude Code em background. Retorna {runId, status}.',
      inputSchema: {
        type: 'object',
        properties: {
          task: str('Instrução completa para o Claude Code (ele não vê esta conversa).'),
          cwd: str('Caminho absoluto do repositório/diretório de trabalho.'),
          title: str('Título curto para o cockpit (opcional).'),
          model: str('Modelo/alias do Claude Code, ex. sonnet, opus (opcional).'),
        },
        required: ['task', 'cwd'],
      },
      handler: ({ task, cwd, title, model }) => {
        const m = createRun({ task, cwd, title, model, requestedBy: requestedBy() })
        return { runId: m.id, status: m.status }
      },
    },
    {
      name: 'claude_spawn_many',
      description: 'Inicia várias runs em paralelo (máx. 8) agrupadas. Retorna {groupId, runIds}.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { task: str('Instrução'), cwd: str('Caminho absoluto (opcional se cwd global)'), title: str('Título') },
              required: ['task'],
            },
          },
          cwd: str('cwd padrão para tarefas sem cwd próprio.'),
          model: str('Modelo padrão (opcional).'),
        },
        required: ['tasks'],
      },
      handler: ({ tasks, cwd, model }) => {
        const r = spawnMany({ tasks, cwd, model, requestedBy: requestedBy() })
        return { groupId: r.groupId, runIds: r.runIds }
      },
    },
    {
      name: 'claude_status',
      description: 'Resumo de uma run (runId) ou de um grupo (groupId); sem argumentos, as runs ativas.',
      inputSchema: { type: 'object', properties: { runId: str('Id da run'), groupId: str('Id do grupo') } },
      handler: ({ runId, groupId }) => {
        if (runId) return summary(readMeta(runId))
        const runs = listRuns(500)
        if (groupId) return runs.filter((r) => r.groupId === groupId).map(summary)
        return runs.filter((r) => !['done', 'error', 'cancelled'].includes(r.status)).map(summary)
      },
    },
    {
      name: 'claude_result',
      description: 'Resultado de uma run: {status, resultText, branch, cwd, diffStat}.',
      inputSchema: { type: 'object', properties: { runId: str('Id da run') }, required: ['runId'] },
      handler: ({ runId }) => result(runId),
    },
    {
      name: 'claude_send',
      description: 'Continua a conversa de uma run terminada (claude --resume) no mesmo worktree. Retorna {runId} da nova run.',
      inputSchema: {
        type: 'object',
        properties: { runId: str('Run a continuar'), message: str('Nova instrução') },
        required: ['runId', 'message'],
      },
      handler: ({ runId, message }) => {
        const m = sendRun(runId, message, requestedBy())
        return { runId: m.id, status: m.status, parentRunId: runId }
      },
    },
    {
      name: 'claude_cancel',
      description: 'Cancela uma run em andamento (mata o claude).',
      inputSchema: { type: 'object', properties: { runId: str('Id da run') }, required: ['runId'] },
      handler: ({ runId }) => {
        const m = cancelRun(runId)
        return { runId, status: m.status }
      },
    },
    {
      name: 'claude_list',
      description: 'Lista as runs mais recentes (padrão 20).',
      inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Máximo de runs' } } },
      handler: ({ limit }) => listRuns(Math.min(Math.max(Number(limit) || 20, 1), 200)).map(summary),
    },
  ],
})
