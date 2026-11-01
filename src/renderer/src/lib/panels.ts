import type { ComponentType } from 'react'
import {
  AgendaWidget,
  DiffWidget,
  InboxWidget,
  QuotaWidget,
  RailQuotaWidget,
  SistemaWidget,
  SwarmWidget,
  TarefasWidget,
  TimeboxWidget,
  type WidgetProps,
} from '../components/panels/widgets'

// Registry de painéis (P1-8). A strip inferior e a área de cards do dock leem
// daqui; quais painéis aparecem em cada região (e em que ordem) é um layout
// serializado em JSON no localStorage, com reset para o padrão.

export type Region = 'strip' | 'dock' | 'rail'

export interface PanelDef {
  id: string
  titulo: string
  componente: ComponentType<WidgetProps>
  /** rota(s) do plugin cockpit lidas pelo painel; vazio = sem fonte ainda */
  fonte: string[]
  refreshMs: number
}

export const PANELS: PanelDef[] = [
  {
    id: 'timebox',
    titulo: 'Hoje · time-boxing',
    componente: TimeboxWidget,
    fonte: ['/foco', '/agenda'],
    refreshMs: 60_000,
  },
  { id: 'tarefas', titulo: 'Tarefas', componente: TarefasWidget, fonte: ['/notion'], refreshMs: 60_000 },
  { id: 'inbox', titulo: 'Inbox triada', componente: InboxWidget, fonte: ['/inbox'], refreshMs: 60_000 },
  { id: 'agenda', titulo: 'Agenda de hoje', componente: AgendaWidget, fonte: ['/agenda'], refreshMs: 60_000 },
  { id: 'quota', titulo: 'Provedores · cota', componente: QuotaWidget, fonte: ['/quota'], refreshMs: 60_000 },
  { id: 'sistema', titulo: 'Sistema · Mac', componente: SistemaWidget, fonte: ['/sistema'], refreshMs: 15_000 },
  { id: 'cota-rail', titulo: 'Provedores · cota (compacto)', componente: RailQuotaWidget, fonte: ['/quota'], refreshMs: 60_000 },
  { id: 'diff', titulo: 'Diff pendente', componente: DiffWidget, fonte: [], refreshMs: 0 },
  { id: 'swarm', titulo: 'Execuções do swarm', componente: SwarmWidget, fonte: [], refreshMs: 0 },
]

export const PANEL_BY_ID: Record<string, PanelDef> = Object.fromEntries(PANELS.map((p) => [p.id, p]))

export type RegionLayout = Record<Region, string[]>

export const DEFAULT_REGIONS: RegionLayout = {
  strip: ['timebox', 'tarefas', 'inbox'],
  dock: ['diff', 'swarm'],
  rail: ['cota-rail'],
}

export const REGION_LABELS: Record<Region, string> = {
  strip: 'Strip inferior',
  dock: 'Cards do dock',
  rail: 'Rodapé da rail',
}

const KEY = 'hermes-cockpit.regions.v1'

export function loadRegions(): RegionLayout {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_REGIONS
    const p = JSON.parse(raw) as Partial<Record<Region, unknown>>
    const clean = (v: unknown, fb: string[]) =>
      Array.isArray(v) ? Array.from(new Set(v.filter((id): id is string => typeof id === 'string' && id in PANEL_BY_ID))) : fb
    return {
      strip: clean(p.strip, DEFAULT_REGIONS.strip),
      dock: clean(p.dock, DEFAULT_REGIONS.dock),
      rail: clean(p.rail, DEFAULT_REGIONS.rail),
    }
  } catch {
    return DEFAULT_REGIONS
  }
}

export function saveRegions(r: RegionLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r))
  } catch {
    /* sem storage: vale só nesta sessão */
  }
}

export function resetRegions(): RegionLayout {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  return DEFAULT_REGIONS
}

/** Liga/desliga um painel numa região (um painel pode estar em várias). */
export function togglePanel(r: RegionLayout, region: Region, id: string): RegionLayout {
  const list = r[region]
  return { ...r, [region]: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] }
}

export function movePanel(r: RegionLayout, region: Region, id: string, delta: -1 | 1): RegionLayout {
  const list = [...r[region]]
  const i = list.indexOf(id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return r
  ;[list[i], list[j]] = [list[j], list[i]]
  return { ...r, [region]: list }
}
