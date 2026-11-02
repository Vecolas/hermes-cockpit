import type { LayoutStorage } from 'react-resizable-panels'
import { getSpace, spaceKey, type Space } from './space'

// Layout do cockpit (P1-7/P1-9): estado de UI persistido (panes abertos, modo
// foco, aba do dock) + constantes de tamanho dos split panes. Os tamanhos
// arrastados pelo usuário são salvos pelo próprio react-resizable-panels
// (useDefaultLayout) através de `safeStorage`.

/** Views da área central (abas da topbar; ⌘1..⌘6 seguem a ordem das VISÍVEIS). */
export const VIEW_IDS = ['chat', 'swarm', 'automacoes', 'notion', 'ops', 'transcrever'] as const
export type ViewId = (typeof VIEW_IDS)[number]
export const isViewId = (v: unknown): v is ViewId => typeof v === 'string' && (VIEW_IDS as readonly string[]).includes(v)

export interface UiPrefs {
  /** view ativa na área central */
  view: ViewId
  railOpen: boolean
  dockOpen: boolean
  stripOpen: boolean
  dockCardsOpen: boolean
  focus: boolean
  dockTab: string
  /** ordem das views na barra (arrastar/configurações); sempre contém todas */
  viewOrder: ViewId[]
  /** views escondidas da barra (continuam no ⌘K) */
  hiddenViews: ViewId[]
}

export const DEFAULT_PREFS: UiPrefs = {
  view: 'chat',
  railOpen: true,
  dockOpen: true,
  stripOpen: true,
  dockCardsOpen: true,
  focus: false,
  dockTab: 'terminal',
  viewOrder: [...VIEW_IDS],
  hiddenViews: [],
}

/** Normaliza uma ordem salva: remove inválidos/duplicados e acrescenta views novas no fim. */
export function normalizeOrder(v: unknown): ViewId[] {
  const list = Array.isArray(v) ? Array.from(new Set(v.filter(isViewId))) : []
  for (const id of VIEW_IDS) if (!list.includes(id)) list.push(id)
  return list
}

/** Views visíveis na barra, na ordem do usuário (nunca vazia: cai no Chat). */
export function visibleViews(p: Pick<UiPrefs, 'viewOrder' | 'hiddenViews'>): ViewId[] {
  const v = normalizeOrder(p.viewOrder).filter((id) => !p.hiddenViews.includes(id))
  return v.length ? v : ['chat']
}

/** Abaixo disso: rail vira overlay, dock vira gaveta, strip rola na horizontal. */
export const NARROW_PX = 1100

// Tamanhos em px (números = px no react-resizable-panels v4).
export const SIZES = {
  rail: { default: 240, min: 180, max: 420 },
  dock: { default: 380, min: 280, max: 720 },
  chatMin: 360,
  strip: { default: 150, min: 96, max: 420 },
  bodyMin: 240,
  dockCards: { default: 300, min: 120 },
  dockTabsMin: 140,
} as const

// ids dos Groups (chave no localStorage: react-resizable-panels:<id>)
export const GROUP_IDS = {
  vertical: 'hc-vertical',
  horizontal: 'hc-horizontal',
  dock: 'hc-dock',
} as const

const PREFS_KEY = 'hermes-cockpit.ui.v1'

/**
 * Prefs de UI POR ESPAÇO (`hermes-cockpit.ui.v1:<espaço>`). Primeira visita a
 * um espaço herda o legado sem sufixo (instalações anteriores à v3).
 */
export function loadPrefs(space: Space = getSpace()): UiPrefs {
  try {
    const raw = localStorage.getItem(spaceKey(PREFS_KEY, space)) ?? localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const p = JSON.parse(raw) as Partial<UiPrefs>
    const b = (v: unknown, fb: boolean) => (typeof v === 'boolean' ? v : fb)
    return {
      view: isViewId(p.view) ? p.view : DEFAULT_PREFS.view,
      railOpen: b(p.railOpen, true),
      dockOpen: b(p.dockOpen, true),
      stripOpen: b(p.stripOpen, true),
      dockCardsOpen: b(p.dockCardsOpen, true),
      focus: b(p.focus, false),
      dockTab: typeof p.dockTab === 'string' ? p.dockTab : DEFAULT_PREFS.dockTab,
      viewOrder: normalizeOrder(p.viewOrder),
      hiddenViews: Array.isArray(p.hiddenViews) ? Array.from(new Set(p.hiddenViews.filter(isViewId))) : [],
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(p: UiPrefs, space: Space = getSpace()): void {
  try {
    localStorage.setItem(spaceKey(PREFS_KEY, space), JSON.stringify(p))
  } catch {
    /* sem storage */
  }
}

/** localStorage que nunca lança (modo privado, quota, etc.). */
export const safeStorage: LayoutStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* ignore */
    }
  },
}

/** Apaga os tamanhos salvos dos split panes. */
export function clearPaneSizes(): void {
  try {
    // inclui os Groups fixos (GROUP_IDS), o da rail e os das regiões (hc-region-*)
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith('react-resizable-panels:hc-')) localStorage.removeItem(k)
    }
  } catch {
    /* ignore */
  }
}
