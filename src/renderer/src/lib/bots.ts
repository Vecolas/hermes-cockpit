// Agrupamento dos bots — espelha o _BOT_GROUPS do plugin cockpit
// (~/.hermes/plugins/cockpit/dashboard/plugin_api.py). Ajuste aqui e lá
// quando entrar bot novo.

export const BOT_GROUPS: Record<string, string> = {
  chief: 'coordenação',
  mercurio: 'coordenação',
  atlas: 'trabalho',
  hefesto: 'trabalho',
  kairos: 'trabalho',
  lar: 'pessoal',
  vesta: 'pessoal',
  argos: 'operações',
}

export const GROUP_ORDER = ['coordenação', 'trabalho', 'pessoal', 'operações', 'outros']

export const GROUP_LABELS: Record<string, string> = {
  coordenação: 'Coordenação',
  trabalho: 'Trabalho · Houer',
  pessoal: 'Pessoal',
  operações: 'Operações',
  outros: 'Outros',
}

export interface BotProfile {
  name: string
  modelo?: string
  sessoes?: number
  rodando?: boolean
  group: string
}

interface RawProfile {
  name?: string
  profile?: string
  id?: string
  model?: string | { default?: string }
  sessions?: number
  session_count?: number
  canonical_session?: unknown
  running?: boolean
  active?: boolean
}

// profiles.list pode evoluir — parse defensivo, nunca quebra a rail.
export function parseProfiles(result: unknown): BotProfile[] {
  const root = (result ?? {}) as Record<string, unknown>
  const list = (Array.isArray(root.profiles) ? root.profiles : Array.isArray(result) ? result : []) as RawProfile[]
  return list
    .map((p): BotProfile | null => {
      const name = String(p.name ?? p.profile ?? p.id ?? '')
      if (!name) return null
      const modelo =
        typeof p.model === 'string' ? p.model : p.model && typeof p.model === 'object' ? p.model.default : undefined
      return {
        name,
        modelo: modelo || undefined,
        sessoes: typeof p.sessions === 'number' ? p.sessions : p.session_count,
        rodando: Boolean(p.running ?? p.active),
        group: BOT_GROUPS[name] ?? 'outros',
      }
    })
    .filter((p): p is BotProfile => p !== null)
}
