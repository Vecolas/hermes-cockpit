// Formatos das rotas do plugin cockpit (~/.hermes/plugins/cockpit/dashboard/plugin_api.py).
// Tudo opcional: o plugin pode evoluir e cada fonte pode falhar sozinha.

export interface AgendaEvent {
  summary?: string
  start?: string
  end?: string
  location?: string
  htmlLink?: string
}

export interface Agenda {
  events?: AgendaEvent[]
  date?: string
  error?: string
}

export interface NotionTask {
  id?: string
  task?: string
  status?: string
  prioridade?: string[]
  categoria?: string[]
  date?: string | null
  end?: string | null
  url?: string
}

export interface Notion {
  hoje?: NotionTask[]
  backlog_high?: NotionTask[]
  in_progress?: NotionTask[]
  counts?: { total?: number; done?: number; abertas?: number }
  error?: string
}

export interface Foco {
  agora?: string
  janela?: string
  proximo_evento?: AgendaEvent | null
  blocos_livres?: Array<{ inicio?: string; fim?: string; minutos?: number }>
  top3_hoje?: NotionTask[]
  erros?: Record<string, string>
}

export interface QuotaJanela {
  nome?: string
  pct?: number
  reset?: string | null
}

export interface QuotaProvedor {
  nome?: string
  plano?: string
  janelas?: QuotaJanela[]
  aviso?: string
  usd?: number
  tokens_in?: number
  tokens_out?: number
}

export interface Quota {
  mes?: string
  gasto_usd?: number
  gasto_brl?: number
  budget_brl?: number
  fx?: number
  provedores?: QuotaProvedor[]
}

export interface InboxItem {
  conta?: string
  from?: string
  subject?: string
  snippet?: string
  date?: string
}

export interface Inbox {
  responder?: InboxItem[]
  ler?: InboxItem[]
  error?: string
}

export interface Sistema {
  cpu_percent?: number
  mem_percent?: number
  mem_used_gb?: number
  mem_total_gb?: number
  disk_percent?: number
  disk_free_gb?: number
  load1?: number | null
  bateria_percent?: number | null
  bateria_carregando?: boolean | null
  ollama?: boolean
  hermes_processes?: number
  gateway?: { status?: string; pid?: number; started_at?: string; version?: string; code_version?: string } | null
}

export const API = {
  foco: '/api/plugins/cockpit/foco',
  agenda: '/api/plugins/cockpit/agenda',
  notion: '/api/plugins/cockpit/notion',
  sistema: '/api/plugins/cockpit/sistema',
  bots: '/api/plugins/cockpit/bots',
  quota: '/api/plugins/cockpit/quota',
  inbox: '/api/plugins/cockpit/inbox',
} as const

/** Maior uso (%) entre as janelas de um provedor, ou null se não houver. */
export function maxPct(p: QuotaProvedor): number | null {
  const pcts = (p.janelas ?? []).map((j) => j.pct).filter((n): n is number => typeof n === 'number')
  return pcts.length ? Math.max(...pcts) : null
}
