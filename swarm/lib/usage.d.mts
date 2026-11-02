// Tipos de swarm/lib/usage.mjs para o main do cockpit (TS).
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
}
export interface RunTokens {
  tokensTotal: number
  tokenUsage?: TokenUsage
}
export const USAGE_FIELDS: [string, keyof TokenUsage][]
export const USAGE_CACHE_FILE: string
export function usageFromResult(ev: unknown): RunTokens | null
export function usageFromMeta(meta: unknown): RunTokens | null
export function lastResultEvent(file: string): Record<string, unknown> | null
export function runUsage(dir: string, meta: unknown, opts?: { terminal?: boolean }): RunTokens | null
export function withUsage<T extends object>(meta: T, dir: string, opts?: { terminal?: boolean }): T & Partial<RunTokens>
export function _resetUsageMemo(): void
