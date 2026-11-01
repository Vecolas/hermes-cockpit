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

// Títulos humanos por bot (cabeçalho do chat, palette, rail). Fallback:
// nome capitalizado — ver botTitle().
export const BOT_TITLES: Record<string, string> = {
  chief: 'Chief of Staff',
  mercurio: 'Mercúrio',
  atlas: 'Atlas',
  hefesto: 'Hefesto',
  kairos: 'Kairós',
  lar: 'Lar',
  vesta: 'Vesta',
  argos: 'Argos',
}

export function botTitle(name: string): string {
  return BOT_TITLES[name] ?? (name ? name[0].toUpperCase() + name.slice(1) : name)
}

export interface BotProfile {
  name: string
  modelo?: string
  sessoes?: number
  rodando?: boolean
  group: string
  /** provider do modelo (plugin /bots) */
  provider?: string
  /** descrição do profile.yaml (plugin /bots) */
  descricao?: string
}

/** Item de /api/plugins/cockpit/bots (plugin_api.py::_bots). */
export interface PluginBot {
  id?: string
  nome?: string
  modelo?: string
  provider?: string
  descricao?: string
  sessoes?: number | null
  grupo?: string
}

// Completa os profiles do RPC com o que o plugin sabe (modelo, provider,
// descrição, contagem de sessões). RPC manda; plugin só preenche lacunas.
// Se o RPC ainda não respondeu, o plugin sozinho já popula a rail.
export function mergePluginBots(rpcBots: BotProfile[], plugin: unknown): BotProfile[] {
  const list = (Array.isArray(plugin) ? plugin : []) as PluginBot[]
  const byId = new Map(list.filter((b) => b && b.id).map((b) => [String(b.id), b]))
  const base: BotProfile[] = rpcBots.length
    ? rpcBots
    : list
        .filter((b) => b.id && b.id !== 'default')
        .map((b) => ({ name: String(b.id), group: BOT_GROUPS[String(b.id)] ?? 'outros' }))
  return base.map((bot) => {
    const p = byId.get(bot.name)
    if (!p) return bot
    return {
      ...bot,
      modelo: bot.modelo ?? (p.modelo || undefined),
      provider: bot.provider ?? (p.provider || undefined),
      descricao: bot.descricao ?? (p.descricao || undefined),
      sessoes: bot.sessoes ?? (typeof p.sessoes === 'number' ? p.sessoes : undefined),
    }
  })
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
  is_default?: boolean
}

// profiles.list pode evoluir — parse defensivo, nunca quebra a rail.
export function parseProfiles(result: unknown): BotProfile[] {
  const root = (result ?? {}) as Record<string, unknown>
  const list = (Array.isArray(root.profiles) ? root.profiles : Array.isArray(result) ? result : []) as RawProfile[]
  return list
    .map((p): BotProfile | null => {
      const name = String(p.name ?? p.profile ?? p.id ?? '')
      // profiles.list inclui o profile "default" (não é bot da rail; o caminho do plugin também o filtra)
      if (!name || name === 'default' || p.is_default === true) return null
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
