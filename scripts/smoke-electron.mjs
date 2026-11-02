#!/usr/bin/env node
// Smoke test REAL do app Electron empacotado (sem mock): lança o executável de
// `electron-builder --dir`, conecta via Chrome DevTools Protocol (nativo do Electron)
// e valida a inicialização do renderer + navegação segura Chat → Swarm → Automações.
//
// O QUE VALIDA: o executável sobe; a janela carrega out/renderer (file://); #root monta;
// a barra de views (role=tablist) renderiza; Chat/Swarm/Automações ativam seus painéis
// sem exceção no renderer nem ErrorBoundary; sem crash no processo main.
// O QUE NÃO VALIDA: integração viva com o Hermes (login, `hermes serve`, WebSocket, chat,
// swarm real). O CI não tem Hermes; erros de conexão ao backend são ESPERADOS e só logados.
//
// Uso: node scripts/smoke-electron.mjs [caminho-do-exe] [--out dir-de-diagnostico]
// Requer Node >= 22 (WebSocket e fetch globais).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : 'smoke-out')
const exe = resolve(args.find((a, i) => !a.startsWith('--') && i !== outIdx + 1) ?? 'release/win-unpacked/Hermes Cockpit.exe')
const PORT = 9333 + Math.floor(Math.random() * 400)
const TOTAL_TIMEOUT_MS = 120_000
const STEP_TIMEOUT_MS = 20_000
const IS_WIN = process.platform === 'win32'

const log = (...a) => console.log('[smoke]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []
const fail = (msg) => {
  failures.push(msg)
  console.error('[smoke] FALHA:', msg)
}

mkdirSync(outDir, { recursive: true })
if (!existsSync(exe)) {
  console.error(`[smoke] executável não encontrado: ${exe}`)
  process.exit(2)
}
const userData = mkdtempSync(join(tmpdir(), 'hermes-cockpit-smoke-'))
let mainLog = ''
let child
let ws
let finished = false

function killTree() {
  if (!child?.pid) return
  try {
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGKILL')
  } catch {
    /* já morreu */
  }
}

async function waitFor(fn, what, timeout = STEP_TIMEOUT_MS) {
  const t0 = Date.now()
  let last
  while (Date.now() - t0 < timeout) {
    if (child && child.exitCode !== null) throw new Error(`app encerrou (code ${child.exitCode}) enquanto aguardava: ${what}`)
    try {
      const v = await fn()
      if (v) return v
    } catch (e) {
      last = e
    }
    await sleep(250)
  }
  throw new Error(`timeout (${timeout / 1000}s) aguardando: ${what}${last ? ` (${last.message})` : ''}`)
}

// --- CDP mínimo -----------------------------------------------------------
let seq = 0
const pending = new Map()
const rendererErrors = []
const rendererWarnings = []

function send(method, params = {}) {
  return new Promise((resolveP, rejectP) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      rejectP(new Error(`CDP ${method} sem resposta`))
    }, STEP_TIMEOUT_MS)
    pending.set(id, { resolveP, rejectP, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

function onMessage(raw) {
  const msg = JSON.parse(String(raw))
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.rejectP(new Error(`${msg.error.message}`))
    else p.resolveP(msg.result)
    return
  }
  switch (msg.method) {
    case 'Runtime.exceptionThrown': {
      const d = msg.params.exceptionDetails
      rendererErrors.push(`exceção não tratada: ${d.exception?.description ?? d.text}`)
      break
    }
    case 'Runtime.consoleAPICalled': {
      if (msg.params.type !== 'error') break
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      // ErrorBoundary do app loga "[cockpit] erro de render em ..." → falha real.
      if (/erro de render/i.test(text)) rendererErrors.push(`ErrorBoundary: ${text.slice(0, 400)}`)
      else rendererWarnings.push(text.slice(0, 300))
      break
    }
    case 'Log.entryAdded': {
      const e = msg.params.entry
      if (e.level !== 'error') break
      // Falha ao carregar o próprio bundle (file://) é fatal; o resto (rede/backend) é esperado sem Hermes.
      if (e.source === 'network' && String(e.url ?? '').startsWith('file:')) rendererErrors.push(`recurso local falhou: ${e.url} — ${e.text}`)
      else rendererWarnings.push(`${e.source}: ${e.text}`.slice(0, 300))
      break
    }
  }
}

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function screenshot(name) {
  try {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(r.data, 'base64'))
  } catch (e) {
    log(`screenshot ${name} falhou: ${e.message}`)
  }
}

async function main() {
  log(`exe: ${exe}`)
  log(`user-data-dir: ${userData} · porta CDP: ${PORT}`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(exe, [`--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  })
  child.stdout.on('data', (c) => (mainLog += c))
  child.stderr.on('data', (c) => (mainLog += c))
  child.on('error', (e) => fail(`falha ao lançar o executável: ${e.message}`))

  // 1) página do renderer (file://) aparece como target
  const target = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    const list = await res.json()
    return list.find((t) => t.type === 'page' && String(t.url).startsWith('file:'))
  }, 'janela do renderer (target CDP file://)')
  log(`target: ${target.url}`)

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('WebSocket CDP falhou'))
  })
  ws.onmessage = (ev) => onMessage(ev.data)
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')

  // 2) UI raiz + navegação principal renderizaram
  await waitFor(() => evalJs(`document.readyState === 'complete' && !!document.querySelector('#root > *')`), '#root com conteúdo React')
  await waitFor(
    () => evalJs(`document.querySelectorAll('[role="tablist"][aria-label="Views"] [role="tab"]').length >= 3`),
    'barra de views (tablist) com abas',
  )
  const tabs = await evalJs(`[...document.querySelectorAll('[role="tablist"][aria-label="Views"] [role="tab"]')].map(t => t.dataset.tabId)`)
  log(`abas renderizadas: ${tabs.join(', ')}`)
  for (const id of ['chat', 'swarm', 'automacoes']) if (!tabs.includes(id)) fail(`aba "${id}" ausente da navegação principal`)
  await screenshot('01-initial')

  // 3) navegação segura: Chat → Swarm → Automações → Chat
  for (const id of ['chat', 'swarm', 'automacoes', 'chat']) {
    if (!tabs.includes(id)) continue
    await evalJs(`document.querySelector('[role="tab"][data-tab-id="${id}"]').click()`)
    await waitFor(
      () =>
        evalJs(`(() => {
          const t = document.querySelector('[role="tab"][data-tab-id="${id}"]')
          const p = document.getElementById('view-${id}')
          return t?.getAttribute('aria-selected') === 'true' && p?.getAttribute('aria-hidden') === 'false' && p.childElementCount > 0
        })()`),
      `view "${id}" ativa e com conteúdo`,
    )
    await sleep(700) // deixa efeitos/montagem assíncrona (e eventual erro de render) aparecerem
    const boundary = await evalJs(
      `[...document.querySelectorAll('#view-${id} .label.text-alert')].map(n => n.textContent).find(t => /·\\s*erro\\s*$/i.test(t)) ?? null`,
    )
    if (boundary) fail(`ErrorBoundary visível na view "${id}": ${boundary.slice(0, 200)}`)
    log(`view "${id}" OK`)
    await screenshot(`02-${id}`)
  }

  // 4) o processo main continua vivo
  if (child.exitCode !== null) fail(`processo main encerrou (code ${child.exitCode})`)
}

const hard = setTimeout(() => {
  fail(`timeout global de ${TOTAL_TIMEOUT_MS / 1000}s`)
  finish()
}, TOTAL_TIMEOUT_MS)

function finish() {
  if (finished) return
  finished = true
  clearTimeout(hard)
  try {
    ws?.close()
  } catch {}
  killTree()
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
  } catch {}
  writeFileSync(join(outDir, 'main.log'), mainLog)
  writeFileSync(join(outDir, 'renderer-console.log'), [...rendererErrors.map((e) => `ERROR ${e}`), ...rendererWarnings.map((w) => `warn  ${w}`)].join('\n'))
  // Crash/exceção no processo main
  if (/Uncaught Exception|A JavaScript error occurred in the main process|UnhandledPromiseRejection/i.test(mainLog)) {
    fail('erro não tratado no processo main (ver main.log)')
  }
  for (const e of rendererErrors) fail(`renderer: ${e}`)
  console.log('--- main stdout/stderr (cauda) ---\n' + mainLog.slice(-3000))
  if (rendererWarnings.length) console.log(`--- ${rendererWarnings.length} avisos/erros ESPERADOS de console (ex.: backend Hermes ausente) ---\n` + rendererWarnings.slice(0, 15).join('\n'))
  console.log(
    failures.length
      ? `\n[smoke] REPROVADO (${failures.length}): ${failures.join(' | ')}`
      : '\n[smoke] APROVADO — inicialização do app + renderer + navegação Chat/Swarm/Automações validados.\n[smoke] NÃO TESTADO: integração viva com Hermes (login, hermes serve, WS, chat/swarm reais).',
  )
  process.exit(failures.length ? 1 : 0)
}

try {
  await main()
} catch (e) {
  fail(e.message)
  if (ws) await screenshot('99-failure')
} finally {
  finish()
}
