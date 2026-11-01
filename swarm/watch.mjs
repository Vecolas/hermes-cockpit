#!/usr/bin/env node
// Acompanha uma run do swarm ao vivo num terminal de verdade (Ghostty/Terminal),
// aberto pelo cockpit (swarm:openTerminal). Lê runs/<id>/events.jsonl em tail e
// imprime o stream-json do Claude Code colorido. Sai quando a run termina.
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs'
import { eventsPath, readMeta, TERMINAL } from './lib/state.mjs'

const id = process.argv[2]
if (!id || !/^r-[\w-]+$/.test(id)) {
  console.error('uso: watch.mjs <runId>')
  process.exit(2)
}

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', amber: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m', reset: '\x1b[0m' }
const out = (s) => process.stdout.write(s + '\n')
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)

function summarize(input) {
  if (!input || typeof input !== 'object') return ''
  const o = input
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description ?? o.prompt
  return typeof v === 'string' ? clip(v.replace(/\s+/g, ' '), 140) : clip(JSON.stringify(o), 140)
}

let lastTask = ''

function render(ev) {
  if (!ev || typeof ev !== 'object') return
  if (ev.type === 'system' && ev.subtype === 'init') {
    out(`${C.dim}── init · ${ev.model ?? '?'} · perm ${ev.permissionMode ?? '?'} · ${ev.cwd ?? ''}${C.reset}`)
  } else if (ev.type === 'system' && (ev.subtype === 'task_started' || ev.subtype === 'task_progress' || ev.subtype === 'task_notification')) {
    const text = ev.subtype === 'task_started' ? `workflow ${ev.workflow_name ?? ''} iniciado — ${ev.description ?? ''}` : String(ev.description ?? ev.summary ?? '')
    if (text === lastTask) return
    lastTask = text
    const u = ev.usage ?? {}
    const meta = [u.tool_uses != null ? `${u.tool_uses} tools` : '', u.total_tokens != null ? `${Math.round(u.total_tokens / 1000)}k tok` : ''].filter(Boolean).join(' · ')
    out(`${C.amber}⟳ ${text}${C.reset}${meta ? ` ${C.dim}[${meta}]${C.reset}` : ''}`)
  } else if (ev.type === 'assistant') {
    for (const b of ev.message?.content ?? []) {
      if (b.type === 'text' && b.text?.trim()) out(b.text.trim())
      else if (b.type === 'thinking' && b.thinking) out(`${C.dim}∴ ${clip(b.thinking.replace(/\s+/g, ' '), 200)}${C.reset}`)
      else if (b.type === 'tool_use') out(`${C.cyan}→ ${b.name}${C.reset} ${C.dim}${summarize(b.input)}${C.reset}`)
    }
  } else if (ev.type === 'user') {
    for (const b of ev.message?.content ?? []) {
      if (b.type !== 'tool_result') continue
      const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x) => x.text ?? '').join('\n')
      const lines = text.split('\n').filter(Boolean).slice(0, 4)
      const tone = b.is_error ? C.red : C.dim
      for (const l of lines) out(`${tone}  │ ${clip(l, 160)}${C.reset}`)
    }
  } else if (ev.type === 'result') {
    const ok = ev.subtype === 'success' && !ev.is_error
    out(`\n${ok ? C.green : C.red}${C.bold}■ ${ok ? 'concluída' : ev.subtype ?? 'erro'}${C.reset} ${C.dim}· ${ev.num_turns ?? '?'} turnos · US$ ${(ev.total_cost_usd ?? 0).toFixed(4)}${C.reset}`)
  }
}

const meta0 = readMeta(id)
out(`${C.amber}${C.bold}◆ ${meta0?.title ?? id}${C.reset}  ${C.dim}${id} · ${meta0?.branch ?? meta0?.cwd ?? ''}${C.reset}\n`)

const file = eventsPath(id)
let pos = 0
let rest = ''
for (;;) {
  if (existsSync(file)) {
    const fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size > pos) {
      const buf = Buffer.alloc(size - pos)
      readSync(fd, buf, 0, buf.length, pos)
      pos = size
      const chunk = rest + buf.toString('utf8')
      const lines = chunk.split('\n')
      rest = lines.pop() ?? ''
      for (const l of lines) {
        try {
          render(JSON.parse(l).ev)
        } catch {
          /* linha parcial/estranha */
        }
      }
    }
    closeSync(fd)
  }
  const m = readMeta(id)
  if (m && TERMINAL.has(m.status) && !rest) {
    out(`${C.dim}── run ${m.status}. Feche a janela quando quiser.${C.reset}`)
    break
  }
  await new Promise((r) => setTimeout(r, 400))
}
