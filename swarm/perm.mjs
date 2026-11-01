#!/usr/bin/env node
// Servidor MCP de permissão do swarm. O runner o passa ao `claude` via
// --mcp-config (nome do servidor: cockpit_perm) e
// --permission-prompt-tool mcp__cockpit_perm__approve.
//
// Cada pedido vira approvals/<id>.json (status pending). O cockpit decide
// reescrevendo o arquivo (status allow|deny). Esperamos por fs.watch + poll de
// 300ms; após 30 min sem decisão → deny. Não escrevemos meta.json: o runner
// observa approvals/ e marca a run como waiting_approval (escritor único).
//
// Contrato do Claude Code (permission-prompt-tool): entrada
// {tool_name, input, tool_use_id?}; saída = texto JSON
// {"behavior":"allow","updatedInput":{...}} | {"behavior":"deny","message":"..."}.
import { existsSync, watch } from 'node:fs'
import { serveMcp } from './lib/mcp.mjs'
import {
  APPROVALS_DIR,
  approvalPath,
  ensureDirs,
  newApprovalId,
  nowIso,
  readJson,
  readMeta,
  writeJsonAtomic,
} from './lib/state.mjs'

const RUN_ID = process.env.RUN_ID || 'unknown'
const TIMEOUT_MS = Number(process.env.SWARM_APPROVAL_TIMEOUT_MS) || 30 * 60 * 1000
const POLL_MS = 300

function waitDecision(id) {
  const file = approvalPath(id)
  return new Promise((resolveP) => {
    let done = false
    let watcher = null
    const finish = (val) => {
      if (done) return
      done = true
      clearInterval(timer)
      clearTimeout(deadline)
      try {
        watcher?.close()
      } catch {
        /* noop */
      }
      resolveP(val)
    }
    const check = () => {
      if (!existsSync(file)) return finish({ status: 'deny', reason: 'arquivo de aprovação removido' })
      try {
        const a = readJson(file)
        if (a.status === 'allow' || a.status === 'deny') finish(a)
      } catch {
        /* escrita em andamento — próximo tick */
      }
    }
    const timer = setInterval(check, POLL_MS)
    const deadline = setTimeout(() => {
      try {
        const a = readJson(file)
        if (a.status === 'pending') {
          writeJsonAtomic(file, { ...a, status: 'deny', decidedAt: nowIso(), reason: 'timeout de 30 min sem decisão' })
        }
      } catch {
        /* noop */
      }
      finish({ status: 'deny', reason: 'timeout de 30 min sem decisão no cockpit' })
    }, TIMEOUT_MS)
    try {
      watcher = watch(APPROVALS_DIR, (_e, name) => {
        if (!name || String(name).startsWith(id)) check()
      })
    } catch {
      /* só poll */
    }
    check()
  })
}

serveMcp({
  name: 'cockpit_perm',
  version: '0.1.0',
  tools: [
    {
      name: 'approve',
      description: 'Pede aprovação ao operador no Hermes Cockpit para uma ferramenta do Claude Code.',
      inputSchema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string' },
          input: { type: 'object' },
          tool_use_id: { type: 'string' },
        },
        required: ['tool_name', 'input'],
      },
      async handler(args) {
        ensureDirs()
        const id = newApprovalId()
        const toolName = String(args.tool_name ?? 'desconhecida')
        // auto/bypass: sem card. O classificador do Claude Code (auto) ou a
        // escolha explícita do operador (bypass) já decidiram; o que ainda
        // chega aqui é aprovado e fica registrado (autoApproved) para auditoria.
        // Perguntas ao usuário (AskUserQuestion) não têm humano em headless:
        // nega com instrução de decidir sozinho.
        let mode = 'manual'
        try {
          mode = readMeta(RUN_ID)?.permissionMode || 'manual'
        } catch {
          /* meta ilegível: segue manual (mais seguro) */
        }
        if (mode === 'auto' || mode === 'bypass') {
          const ask = toolName === 'AskUserQuestion'
          writeJsonAtomic(approvalPath(id), {
            id,
            runId: RUN_ID,
            toolName,
            input: args.input ?? {},
            status: ask ? 'deny' : 'allow',
            autoApproved: true,
            reason: ask ? `modo ${mode}: sem perguntas ao operador` : `modo ${mode}`,
            createdAt: nowIso(),
            decidedAt: nowIso(),
          })
          if (ask) {
            return JSON.stringify({
              behavior: 'deny',
              message:
                'Execução autônoma (modo ' +
                mode +
                '): não há operador para responder. Decida você mesmo com a opção mais razoável, siga em frente e registre as suposições no resultado final.',
            })
          }
          return JSON.stringify({ behavior: 'allow', updatedInput: args.input ?? {} })
        }
        const approval = {
          id,
          runId: RUN_ID,
          toolName: String(args.tool_name ?? 'desconhecida'),
          input: args.input ?? {},
          ...(args.tool_use_id ? { toolUseId: String(args.tool_use_id) } : {}),
          status: 'pending',
          createdAt: nowIso(),
        }
        writeJsonAtomic(approvalPath(id), approval)
        const d = await waitDecision(id)
        if (d.status === 'allow') {
          return JSON.stringify({ behavior: 'allow', updatedInput: d.updatedInput ?? approval.input })
        }
        return JSON.stringify({
          behavior: 'deny',
          message: d.reason ? `Negado pelo operador: ${d.reason}` : 'Negado pelo operador no Hermes Cockpit.',
        })
      },
    },
  ],
})
