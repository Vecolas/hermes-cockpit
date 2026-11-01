#!/usr/bin/env node
// CLI fina usada pelo main do cockpit (src/main/ipc/swarm.ts) para as ações
// que spawnam/limpam runs. Imprime UMA linha JSON: {ok:true, data} | {ok:false, error}.
//   node cli.mjs spawn '<json {task,cwd,title?,model?,groupId?}>'
//   node cli.mjs send <runId> '<message>'
//   node cli.mjs cleanup <runId>
//   node cli.mjs cancel <runId>
//   node cli.mjs version
import { cancelRun, claudeVersion, cleanupRun, createRun, sendRun } from './lib/runs.mjs'
import { readSwarmConfig, writeSwarmConfig } from './lib/state.mjs'

const [cmd, a1, a2] = process.argv.slice(2)
const cockpit = { via: 'cockpit' }

function run() {
  switch (cmd) {
    case 'spawn': {
      const o = JSON.parse(a1 || '{}')
      return createRun({ task: o.task, cwd: o.cwd, title: o.title, model: o.model, groupId: o.groupId, permissionMode: o.permissionMode, requestedBy: cockpit })
    }
    case 'send':
      return sendRun(a1, a2, cockpit)
    case 'cleanup':
      return cleanupRun(a1)
    case 'cancel':
      return cancelRun(a1)
    case 'config-get':
      return readSwarmConfig()
    case 'config-set':
      return writeSwarmConfig(JSON.parse(a1 || '{}'))
    case 'version':
      return { claudeVersion: claudeVersion() }
    default:
      throw new Error(`comando desconhecido: ${cmd}`)
  }
}

try {
  process.stdout.write(JSON.stringify({ ok: true, data: run() }) + '\n')
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) + '\n')
  process.exitCode = 1
}
