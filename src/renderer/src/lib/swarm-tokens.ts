// Consumo do swarm em TOKENS (regra: US$ só em cotas de créditos). Puro, sem
// React — testado com `node --test`. Os números vêm do main (meta.tokensTotal,
// gravado pelo runner ou lido do último result de events.jsonl); aqui só se
// agrega e formata, nunca se estima nem converte.
import { fmtTokens } from '../components/panels/types.ts'

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/** Soma real dos quatro campos de `ev.usage` de um evento result; undefined se nenhum vier. */
export function resultTokens(ev: { usage?: unknown } | null | undefined): number | undefined {
  const u = ev?.usage
  if (!u || typeof u !== 'object') return undefined
  let total = 0
  let any = false
  for (const k of USAGE_KEYS) {
    const v = (u as Record<string, unknown>)[k]
    if (isCount(v)) {
      total += v
      any = true
    }
  }
  return any ? total : undefined
}

export interface TokenRun {
  createdAt: string
  tokensTotal?: number
}

export interface TokenWindow {
  /** soma das runs da janela com dado real; null se nenhuma tiver */
  total: number | null
  /** runs da janela com tokens */
  counted: number
  /** runs da janela sem dado de tokens (ativas, sem result, antigas sem usage) */
  missing: number
}

/** Tokens das runs criadas nas últimas `windowMs` (padrão 24h). */
export function tokensInWindow(runs: readonly TokenRun[], now: number, windowMs = 86_400_000): TokenWindow {
  let total = 0
  let counted = 0
  let missing = 0
  for (const r of runs) {
    const t = Date.parse(r.createdAt)
    if (!Number.isFinite(t) || now - t >= windowMs || t > now) continue
    if (isCount(r.tokensTotal)) {
      total += r.tokensTotal
      counted++
    } else missing++
  }
  return { total: counted ? total : null, counted, missing }
}

/** "12k tok" / "—" (ausência honesta). */
export function fmtRunTokens(n: number | null | undefined): string {
  return isCount(n) ? `${fmtTokens(n)} tok` : '—'
}

export { fmtTokens }

/** Tooltip com os componentes reais do uso (só os que vieram). */
export function tokenBreakdown(run: {
  tokensTotal?: number
  tokenUsage?: { inputTokens?: number; outputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
}): string | undefined {
  if (!isCount(run.tokensTotal)) return undefined
  const u = run.tokenUsage ?? {}
  const parts: [string, number | undefined][] = [
    ['input', u.inputTokens],
    ['output', u.outputTokens],
    ['cache write', u.cacheCreationInputTokens],
    ['cache read', u.cacheReadInputTokens],
  ]
  const fmt = (n: number) => n.toLocaleString('pt-BR')
  const detail = parts.filter((p): p is [string, number] => isCount(p[1])).map(([k, v]) => `${k} ${fmt(v)}`)
  return `${fmt(run.tokensTotal)} tokens${detail.length ? ` · ${detail.join(' · ')}` : ''}`
}
