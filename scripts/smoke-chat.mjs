#!/usr/bin/env node
// Smoke test REAL do contrato de chat contra `hermes serve`.
//
// Valida os nomes de métodos/params que src/renderer/src/lib/gateway.ts usa:
//   profiles.list · session.list {title:"Bot Chat", include_hidden} · commands.catalog ·
//   config.get {key:"provider"} · model.options · session.create · prompt.submit
// e registra os eventos de streaming que chegam para UM prompt curto.
//
// Para não poluir o "Bot Chat" canônico do chief (chat eterno do usuário), o prompt vai
// para uma sessão descartável (hidden, título "cockpit smoke") que é apagada no fim.
//
// Uso:  node scripts/smoke-chat.mjs [--no-prompt]
// Sobe o próprio `hermes serve` (porta 0, token próprio) e o mata ao final.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROFILE = 'chief'
const NO_PROMPT = process.argv.includes('--no-prompt')
const READY_RE = /HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/

function hermesBin() {
  for (const p of [join(homedir(), '.local/bin/hermes'), '/opt/homebrew/bin/hermes', '/usr/local/bin/hermes']) {
    if (existsSync(p)) return p
  }
  return 'hermes'
}

const token = randomBytes(24).toString('hex')
const env = { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(hermesBin(), ['serve', '--host', '127.0.0.1', '--port', '0'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let killed = false
function killServe() {
  if (killed) return
  killed = true
  try {
    child.kill('SIGTERM')
  } catch {}
  setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {}
  }, 3000).unref()
}
process.on('exit', killServe)
process.on('SIGINT', () => {
  killServe()
  process.exit(130)
})

const port = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('serve não ficou pronto em 90s\n' + buf.slice(-2000))), 90_000)
  const on = (d) => {
    buf += d.toString()
    const m = buf.match(READY_RE)
    if (m) {
      clearTimeout(t)
      resolve(Number(m[1]))
    }
  }
  child.stdout.on('data', on)
  child.stderr.on('data', on)
  child.on('exit', (c) => reject(new Error(`serve saiu (${c})\n${buf.slice(-2000)}`)))
})
console.log(`[smoke] serve pid=${child.pid} port=${port}`)

const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws falhou'))
})

let seq = 0
const pending = new Map()
const events = [] // {type, session_id, payload}
const serverRequests = []
const listeners = new Set()

ws.onmessage = (ev) => {
  const f = JSON.parse(String(ev.data))
  if (f.id !== undefined && f.method === undefined) {
    const p = pending.get(String(f.id))
    if (!p) return
    pending.delete(String(f.id))
    f.error ? p.reject(new Error(`${f.error.code}: ${f.error.message}`)) : p.resolve(f.result)
    return
  }
  if (f.id !== undefined && typeof f.method === 'string' && f.method !== 'event') {
    // server request (approval/clarify/...) — no smoke negamos tudo
    serverRequests.push({ method: f.method, params: f.params })
    const result = f.method === 'approval' ? { choice: 'deny' } : f.method === 'clarify' ? { answer: '' } : null
    ws.send(
      JSON.stringify(
        result
          ? { jsonrpc: '2.0', id: f.id, result }
          : { jsonrpc: '2.0', id: f.id, error: { code: -32601, message: 'smoke: sem handler' } },
      ),
    )
    return
  }
  if (f.method === 'event' && f.params) {
    events.push(f.params)
    for (const l of listeners) l(f.params)
  }
}

function call(method, params = {}, timeoutMs = 60_000) {
  const id = `s${++seq}`
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (v) => (clearTimeout(t), resolve(v)),
      reject: (e) => (clearTimeout(t), reject(e)),
    })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
}

const report = { ok: [], fail: [] }
async function step(name, fn) {
  try {
    const r = await fn()
    report.ok.push(name)
    return r
  } catch (e) {
    report.fail.push(`${name}: ${e.message}`)
    console.log(`[smoke] FALHA ${name}: ${e.message}`)
    return undefined
  }
}

try {
  const profiles = await step('profiles.list', () => call('profiles.list', {}))
  const chief = profiles?.profiles?.find((p) => p.name === PROFILE)
  console.log('[smoke] profiles:', profiles?.profiles?.map((p) => p.name).join(', '))
  console.log('[smoke] chief:', JSON.stringify({ model: chief?.model, provider: chief?.provider, display_name: chief?.display_name, canonical_session: chief?.canonical_session ? { id: chief.canonical_session.id, resolved_id: chief.canonical_session.resolved_id, message_count: chief.canonical_session.message_count } : null }))

  const list = await step('session.list(title=Bot Chat)', () =>
    call('session.list', { profile: PROFILE, title: 'Bot Chat', limit: 200, include_hidden: true }),
  )
  console.log(
    '[smoke] Bot Chat rows:',
    JSON.stringify((list?.sessions ?? []).map((s) => ({ id: s.id, resolved_id: s.resolved_id, title: s.title, message_count: s.message_count, source: s.source }))),
  )

  const side = await step('session.list(profile)', () => call('session.list', { profile: PROFILE, limit: 20 }))
  console.log('[smoke] side-chats visíveis:', (side?.sessions ?? []).length, JSON.stringify((side?.sessions ?? []).slice(0, 3).map((s) => ({ id: s.id, title: s.title }))))

  const cat = await step('commands.catalog', () => call('commands.catalog', { profile: PROFILE }))
  if (cat) {
    console.log('[smoke] catalog keys:', Object.keys(cat).join(','), '| pairs:', cat.pairs?.length, '| categories:', (cat.categories ?? []).map((c) => `${c.name}(${c.pairs?.length ?? 0})`).join(' '), '| skills:', cat.skill_count)
    console.log('[smoke] pairs[0..4]:', JSON.stringify((cat.pairs ?? []).slice(0, 5)))
  }

  const prov = await step('config.get(provider)', () => call('config.get', { profile: PROFILE, key: 'provider' }))
  console.log('[smoke] provider:', JSON.stringify({ model: prov?.model, provider: prov?.provider }))

  const full = await step('config.get(full)', () => call('config.get', { profile: PROFILE, key: 'full' }))
  console.log('[smoke] fallback_model:', JSON.stringify(full?.config?.fallback_model ?? null), '| model cfg:', JSON.stringify(full?.config?.model ?? null))

  const opts = await step('model.options', () => call('model.options', { profile: PROFILE }, 90_000))
  if (opts) {
    console.log('[smoke] model.options current:', opts.provider, opts.model, '| providers:', (opts.providers ?? []).map((p) => `${p.slug}[${p.models?.length ?? 0}]${p.authenticated === false ? '!' : ''}`).join(' '))
  }

  // Abre o Bot Chat canônico como o ChatPane faz (resume pelo id ARMAZENADO, sem prompt).
  const botChat = (list?.sessions ?? []).find((s) => s.title === 'Bot Chat')
  if (botChat) {
    const t0 = Date.now()
    const resumed = await step('session.resume(Bot Chat)', () =>
      call('session.resume', { session_id: botChat.resolved_id || botChat.id, profile: PROFILE }, 90_000),
    )
    if (resumed) {
      const roles = {}
      for (const m of resumed.messages ?? []) roles[m.role] = (roles[m.role] ?? 0) + 1
      console.log('[smoke] session.resume →', JSON.stringify({ ms: Date.now() - t0, session_id: resumed.session_id, stored: resumed.stored_session_id, resumed: resumed.resumed, running: resumed.running, message_count: resumed.message_count, roles, info_model: resumed.info?.model, approval_mode: resumed.info?.approval_mode, pending_approval: resumed.pending_approval ?? null, open_requests: (resumed.open_requests ?? []).length }))
      const tool = (resumed.messages ?? []).find((m) => m.role === 'tool')
      if (tool) console.log('[smoke] exemplo tool row:', JSON.stringify({ name: tool.name, context: tool.context, argsKeys: Object.keys(tool.args ?? {}) }))
      await step('session.close(Bot Chat runtime)', () => call('session.close', { session_id: resumed.session_id }))
    }
  }

  if (!NO_PROMPT) {
    const created = await step('session.create', () =>
      call('session.create', { profile: PROFILE, title: 'cockpit smoke', hidden: true, follow_profile_config: true }),
    )
    const sid = created?.session_id
    const stored = created?.stored_session_id
    console.log('[smoke] session.create →', JSON.stringify({ session_id: sid, stored_session_id: stored, info_model: created?.info?.model }))
    if (sid) {
      const done = new Promise((resolve) => {
        const t = setTimeout(() => resolve('timeout'), 180_000)
        listeners.add((e) => {
          if (e.session_id === sid && e.type === 'message.complete') {
            clearTimeout(t)
            resolve('complete')
          }
        })
      })
      const submit = await step('prompt.submit', () => call('prompt.submit', { session_id: sid, text: 'responda só: ok' }))
      console.log('[smoke] prompt.submit →', JSON.stringify(submit))
      const outcome = await done
      console.log('[smoke] turno:', outcome)
      const mine = events.filter((e) => e.session_id === sid)
      const counts = {}
      for (const e of mine) counts[e.type] = (counts[e.type] ?? 0) + 1
      console.log('[smoke] eventos da sessão (ordem de 1ª ocorrência):', JSON.stringify(counts))
      const deltas = mine.filter((e) => e.type === 'message.delta').map((e) => e.payload?.text ?? '')
      console.log('[smoke] deltas:', JSON.stringify(deltas))
      const complete = mine.find((e) => e.type === 'message.complete')
      console.log('[smoke] message.complete:', JSON.stringify({ text: complete?.payload?.text, status: complete?.payload?.status, keys: Object.keys(complete?.payload ?? {}) }))
      const sample = {}
      for (const e of mine) if (!sample[e.type]) sample[e.type] = { seq: e.seq, payloadKeys: Object.keys(e.payload ?? {}) }
      console.log('[smoke] amostra envelope por tipo:', JSON.stringify(sample))

      const hist = await step('session.history', () => call('session.history', { session_id: sid }))
      console.log('[smoke] history:', JSON.stringify((hist?.messages ?? []).map((m) => ({ role: m.role, text: (m.text ?? '').slice(0, 40) }))))

      // limpeza: fecha a sessão viva e apaga a linha descartável
      await step('session.close', () => call('session.close', { session_id: sid }))
      if (stored) await step('session.delete', () => call('session.delete', { session_id: stored, profile: PROFILE }))
    }
  }
  const globalTypes = [...new Set(events.filter((e) => !e.session_id).map((e) => e.type))]
  console.log('[smoke] eventos sem session_id:', JSON.stringify(globalTypes))
  console.log('[smoke] server requests:', JSON.stringify(serverRequests.map((r) => r.method)))
} finally {
  console.log(`[smoke] OK: ${report.ok.join(' · ')}`)
  if (report.fail.length) console.log(`[smoke] FALHAS: ${report.fail.join(' | ')}`)
  try {
    ws.close()
  } catch {}
  killServe()
  setTimeout(() => process.exit(report.fail.length ? 1 : 0), 500)
}
