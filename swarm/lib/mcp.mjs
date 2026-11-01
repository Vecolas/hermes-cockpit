// Servidor MCP stdio mínimo (JSON-RPC 2.0, uma mensagem por linha).
// Implementa: initialize, notifications/initialized, ping, tools/list, tools/call.
// stdout é EXCLUSIVO do protocolo; logs vão para stderr.
import { createInterface } from 'node:readline'

// Versões que sabemos falar; ecoamos a do cliente se estiver aqui (o cliente
// MCP do Hermes — SDK python — pede 2025-03-26/2025-06-18; o Claude Code idem).
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK = '2025-06-18'

/**
 * @param {{name:string, version:string, instructions?:string,
 *   tools: {name:string, description:string, inputSchema:object, handler:(args:any)=>Promise<any>|any}[]}} spec
 */
export function serveMcp(spec) {
  const byName = new Map(spec.tools.map((t) => [t.name, t]))
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  async function onMessage(msg) {
    const { id, method, params } = msg
    const isRequest = id !== undefined && id !== null
    if (!method) return // resposta a algo que não pedimos: ignora
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion
        reply(id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : FALLBACK,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: spec.name, version: spec.version },
          ...(spec.instructions ? { instructions: spec.instructions } : {}),
        })
        return
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return
      case 'ping':
        if (isRequest) reply(id, {})
        return
      case 'tools/list':
        reply(id, {
          tools: spec.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        })
        return
      case 'tools/call': {
        const tool = byName.get(params?.name)
        if (!tool) return fail(id, -32602, `ferramenta desconhecida: ${params?.name}`)
        try {
          const out = await tool.handler(params?.arguments ?? {})
          const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2)
          reply(id, { content: [{ type: 'text', text }], isError: false })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          reply(id, { content: [{ type: 'text', text: `erro: ${message}` }], isError: true })
        }
        return
      }
      default:
        if (isRequest) fail(id, -32601, `método não suportado: ${method}`)
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let msg
    try {
      msg = JSON.parse(s)
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const batch = Array.isArray(msg) ? msg : [msg]
    for (const m of batch) {
      onMessage(m).catch((err) => process.stderr.write(`[${spec.name}] ${err?.stack || err}\n`))
    }
  })
  rl.on('close', () => process.exit(0))
}
