import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmtTokens, providerUsage, totalTokens } from './types.ts'

test('fmtTokens compacta', () => {
  assert.equal(fmtTokens(0), '0')
  assert.equal(fmtTokens(999), '999')
  assert.equal(fmtTokens(12_400), '12k')
  assert.equal(fmtTokens(2_500_000), '2.5M')
})

test('tokens é o padrão mesmo com usd presente', () => {
  const u = providerUsage({ usd: 3.2, tokens_in: 1000, tokens_out: 2000 })
  assert.equal(u.kind, 'tokens')
  assert.equal(u.text, '3k tokens')
  assert.ok(!u.text?.includes('US$'))
})

test('unidade=tokens explícita também não mostra USD', () => {
  assert.equal(providerUsage({ unidade: 'tokens', usd: 9, tokens_in: 5 }).text, '5 tokens')
})

test('créditos explícitos mostram USD', () => {
  const u = providerUsage({ unidade: 'creditos', usd: 4.5, tokens_in: 1000 })
  assert.equal(u.kind, 'creditos')
  assert.equal(u.text, 'US$ 4.50')
})

test('créditos sem usd numérico caem para tokens', () => {
  assert.equal(providerUsage({ unidade: 'creditos', tokens_in: 2000, tokens_out: 1000 }).text, '3k tokens')
})

test('zero e ausente', () => {
  assert.equal(providerUsage({ tokens_in: 0, tokens_out: 0 }).text, '0 tokens')
  assert.equal(providerUsage({ unidade: 'creditos', usd: 0 }).text, 'US$ 0.00')
  const none = providerUsage({ usd: 7 })
  assert.equal(none.kind, 'none')
  assert.equal(none.text, null)
  assert.equal(providerUsage({}).kind, 'none')
})

test('totalTokens soma input+output e ignora ausentes', () => {
  assert.equal(totalTokens([{ tokens_in: 1, tokens_out: 2 }, { usd: 5 }, { tokens_out: 4 }]), 7)
  assert.equal(totalTokens([{ usd: 5 }, {}]), null)
  assert.equal(totalTokens(undefined), null)
})
