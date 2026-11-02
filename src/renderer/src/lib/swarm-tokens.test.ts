import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtRunTokens, resultTokens, tokenBreakdown, tokensInWindow } from './swarm-tokens.ts'

const NOW = Date.parse('2026-11-02T15:00:00Z')
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

test('tokensInWindow soma só tokens reais das últimas 24h', () => {
  const w = tokensInWindow(
    [
      { createdAt: ago(1), tokensTotal: 1_000 },
      { createdAt: ago(23.9), tokensTotal: 250_500 },
      { createdAt: ago(2) }, // ativa/sem result: fora da soma, contada como faltante
      { createdAt: ago(25), tokensTotal: 9_999_999 }, // fora da janela
      { createdAt: 'lixo', tokensTotal: 5 },
    ],
    NOW,
  )
  assert.deepEqual(w, { total: 251_500, counted: 2, missing: 1 })
})

test('tokensInWindow: sem dado → null (nunca 0 inventado)', () => {
  assert.deepEqual(tokensInWindow([{ createdAt: ago(1) }, { createdAt: ago(3) }], NOW), { total: null, counted: 0, missing: 2 })
  assert.deepEqual(tokensInWindow([], NOW), { total: null, counted: 0, missing: 0 })
  // zero real é zero, não ausência
  assert.equal(tokensInWindow([{ createdAt: ago(1), tokensTotal: 0 }], NOW).total, 0)
})

test('resultTokens soma input/output/cache do evento result', () => {
  assert.equal(
    resultTokens({ usage: { input_tokens: 18, output_tokens: 13195, cache_creation_input_tokens: 49207, cache_read_input_tokens: 225507, service_tier: 'standard' } }),
    287_927,
  )
  assert.equal(resultTokens({ usage: { output_tokens: 4 } }), 4)
  assert.equal(resultTokens({}), undefined)
  assert.equal(resultTokens({ usage: { total_cost_usd: 3 } }), undefined)
})

test('fmtRunTokens compacta e mostra ausência honesta, sem US$', () => {
  assert.equal(fmtRunTokens(287_927), '288k tok')
  assert.equal(fmtRunTokens(2_500_000), '2.5M tok')
  assert.equal(fmtRunTokens(undefined), '—')
  assert.ok(!fmtRunTokens(12).includes('US$'))
})

test('tokenBreakdown lista só componentes presentes', () => {
  assert.equal(tokenBreakdown({}), undefined)
  const t = tokenBreakdown({ tokensTotal: 30, tokenUsage: { inputTokens: 10, outputTokens: 20 } })
  assert.ok(t?.startsWith('30 tokens'))
  assert.ok(t?.includes('input 10') && t.includes('output 20') && !t.includes('cache'))
})
