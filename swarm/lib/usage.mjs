// Consumo de tokens das runs (Node ESM puro, sem deps).
//
// Fonte: o evento `type=result` do `claude -p --output-format stream-json` traz
// `usage` com input_tokens, output_tokens, cache_creation_input_tokens e
// cache_read_input_tokens. tokensTotal = soma real desses campos (só os que
// vieram como número; nada é estimado nem convertido de US$).
//
// Runs novas: o runner grava os campos no meta.json ao ver o result.
// Runs históricas: leitura lazy do ÚLTIMO result de events.jsonl (varredura de
// trás para frente, sem ler o arquivo inteiro) com cache em usage.json por run,
// chaveado por tamanho+mtime de events.jsonl — o meta.json não é reescrito
// (o runner é o escritor único dele) e polls seguintes não releem eventos.
// Usado por run.mjs, lib/runs.mjs e pelo main do cockpit (src/main/ipc/swarm.ts).
import { closeSync, existsSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const USAGE_FIELDS = [
  ['input_tokens', 'inputTokens'],
  ['output_tokens', 'outputTokens'],
  ['cache_creation_input_tokens', 'cacheCreationInputTokens'],
  ['cache_read_input_tokens', 'cacheReadInputTokens'],
]
export const USAGE_CACHE_FILE = 'usage.json'
const CACHE_VERSION = 1
const CHUNK = 64 * 1024

const isCount = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * `ev.usage` de um evento result → { tokensTotal, tokenUsage } ou null se não
 * houver nenhum dos quatro campos numéricos.
 */
export function usageFromResult(ev) {
  const u = ev && typeof ev === 'object' ? ev.usage : null
  if (!u || typeof u !== 'object') return null
  const tokenUsage = {}
  let total = 0
  let any = false
  for (const [src, dst] of USAGE_FIELDS) {
    if (!isCount(u[src])) continue
    tokenUsage[dst] = u[src]
    total += u[src]
    any = true
  }
  return any ? { tokensTotal: total, tokenUsage } : null
}

/** Campos de uso já presentes no meta (gravados pelo runner), ou null. */
export function usageFromMeta(meta) {
  if (!meta || !isCount(meta.tokensTotal)) return null
  return { tokensTotal: meta.tokensTotal, ...(meta.tokenUsage ? { tokenUsage: meta.tokenUsage } : {}) }
}

/**
 * Último evento `type=result` de um events.jsonl (linhas `{ts, ev}`), lendo do
 * fim em blocos. Linha final incompleta (append em curso) é ignorada se não
 * parsear. Retorna o `ev` ou null.
 */
export function lastResultEvent(file) {
  let fd
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    let pos = statSync(file).size
    let tail = Buffer.alloc(0) // bytes ainda sem '\n' à esquerda
    while (pos > 0) {
      const len = Math.min(CHUNK, pos)
      pos -= len
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, pos)
      tail = Buffer.concat([buf, tail])
      let nl
      while ((nl = tail.lastIndexOf(0x0a)) !== -1) {
        const line = tail.subarray(nl + 1)
        tail = tail.subarray(0, nl)
        const ev = parseResultLine(line)
        if (ev) return ev
      }
    }
    return parseResultLine(tail) // primeira linha do arquivo
  } finally {
    closeSync(fd)
  }
}

const RESULT_MARK = Buffer.from('"type":"result"')

function parseResultLine(buf) {
  if (!buf.length || buf.indexOf(RESULT_MARK) === -1) return null
  try {
    const o = JSON.parse(buf.toString('utf8'))
    const ev = o && typeof o === 'object' && 'ev' in o ? o.ev : o
    return ev && ev.type === 'result' ? ev : null
  } catch {
    return null
  }
}

// cache em memória do processo (main do cockpit faz poll): dir → entrada
const mem = new Map()

function readCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    return c && c.v === CACHE_VERSION ? c : null
  } catch {
    return null
  }
}

function writeCache(file, data) {
  try {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data) + '\n')
    renameSync(tmp, file)
  } catch {
    /* sem permissão/disco: segue só com cache em memória */
  }
}

/**
 * Uso de tokens de uma run: meta (runner) → cache (memória/usage.json válido
 * para o tamanho+mtime atuais de events.jsonl) → varredura do último result.
 * Runs não terminais sem uso no meta não são varridas (ainda sem result).
 */
export function runUsage(dir, meta, { terminal = true } = {}) {
  const fromMeta = usageFromMeta(meta)
  if (fromMeta) return fromMeta
  if (!terminal) return null
  const events = join(dir, 'events.jsonl')
  let st
  try {
    st = statSync(events)
  } catch {
    return null
  }
  const key = { size: st.size, mtimeMs: Math.floor(st.mtimeMs) }
  const same = (c) => c && c.size === key.size && c.mtimeMs === key.mtimeMs
  const hit = mem.get(dir)
  if (same(hit)) return hit.usage
  const cacheFile = join(dir, USAGE_CACHE_FILE)
  const disk = existsSync(cacheFile) ? readCache(cacheFile) : null
  if (same(disk)) {
    mem.set(dir, disk)
    return disk.usage
  }
  const usage = usageFromResult(lastResultEvent(events))
  const entry = { v: CACHE_VERSION, ...key, usage }
  mem.set(dir, entry)
  writeCache(cacheFile, entry)
  return usage
}

/** meta + tokensTotal/tokenUsage (quando houver dado real). */
export function withUsage(meta, dir, opts) {
  const u = runUsage(dir, meta, opts)
  return u ? { ...meta, ...u } : meta
}

/** Para testes: esquece o cache em memória. */
export function _resetUsageMemo() {
  mem.clear()
}
