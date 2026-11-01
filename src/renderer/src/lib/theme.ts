// Temas (P1-10): presets sobre os tokens @theme de index.css, aplicados como
// overrides de variáveis CSS no <html>. Accent, fonte e escala (densidade)
// são ajustáveis à parte; tudo persistido em localStorage.

export type ThemePreset = 'grafite' | 'fosforo' | 'ambar' | 'claro'

export interface ThemeSettings {
  preset: ThemePreset
  /** cor de acento (substitui --color-amber); null = a do preset */
  accent: string | null
  font: FontId
  /** escala da UI em %, 85..125 */
  scale: number
}

export type FontId = 'sf-mono' | 'jetbrains' | 'menlo' | 'sans'

export const FONTS: Record<FontId, { label: string; stack: string }> = {
  'sf-mono': {
    label: 'SF Mono',
    stack: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
  },
  jetbrains: {
    label: 'JetBrains Mono',
    stack: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  },
  menlo: { label: 'Menlo', stack: 'Menlo, Monaco, ui-monospace, monospace' },
  sans: {
    label: 'Sans (sistema)',
    stack: 'ui-sans-serif, -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif',
  },
}

type Tokens = Record<string, string>

// Só as variáveis que mudam em relação ao @theme base (grafite).
export const PRESETS: Record<ThemePreset, { label: string; tokens: Tokens }> = {
  grafite: { label: 'Grafite', tokens: {} },
  fosforo: {
    label: 'Fósforo',
    tokens: {
      '--color-void': '#070b08',
      '--color-panel': '#0c120e',
      '--color-panel2': '#111a14',
      '--color-edge': '#1a261d',
      '--color-edge2': '#24362a',
      '--color-ink': '#c9f2cf',
      '--color-dim': '#7fae88',
      '--color-faint': '#4a6a51',
      '--color-amber': '#7ee787',
      '--color-phos': '#b8f7a0',
    },
  },
  ambar: {
    label: 'Âmbar',
    tokens: {
      '--color-void': '#0d0a06',
      '--color-panel': '#140f09',
      '--color-panel2': '#1b140c',
      '--color-edge': '#2a1f12',
      '--color-edge2': '#3a2b18',
      '--color-ink': '#f1d6a8',
      '--color-dim': '#b8935c',
      '--color-faint': '#76603f',
      '--color-amber': '#ffb547',
    },
  },
  claro: {
    label: 'Claro',
    tokens: {
      '--color-void': '#f4f5f7',
      '--color-panel': '#ffffff',
      '--color-panel2': '#eceef2',
      '--color-edge': '#dde1e7',
      '--color-edge2': '#c7cdd6',
      '--color-ink': '#1b1f26',
      '--color-dim': '#4d5562',
      '--color-faint': '#7d8593',
      '--color-amber': '#b86e00',
      '--color-phos': '#1f8f3a',
      '--color-cyanic': '#1f6fc4',
      '--color-alert': '#c2342b',
    },
  },
}

export const SCALE_MIN = 85
export const SCALE_MAX = 125
export const SCALE_STEP = 5

export const DEFAULT_THEME: ThemeSettings = {
  preset: 'grafite',
  accent: null,
  font: 'sf-mono',
  scale: 100,
}

const KEY = 'hermes-cockpit.theme.v1'

export function clampScale(n: number): number {
  if (!Number.isFinite(n)) return 100
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n / SCALE_STEP) * SCALE_STEP))
}

export function loadTheme(): ThemeSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_THEME
    const p = JSON.parse(raw) as Partial<ThemeSettings>
    return {
      preset: p.preset && p.preset in PRESETS ? p.preset : DEFAULT_THEME.preset,
      accent: typeof p.accent === 'string' && /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent : null,
      font: p.font && p.font in FONTS ? p.font : DEFAULT_THEME.font,
      scale: clampScale(Number(p.scale ?? 100)),
    }
  } catch {
    return DEFAULT_THEME
  }
}

export function saveTheme(t: ThemeSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t))
  } catch {
    /* storage indisponível: tema vale só nesta sessão */
  }
}

const ALL_TOKENS = Array.from(
  new Set(Object.values(PRESETS).flatMap((p) => Object.keys(p.tokens))),
)

// Aplica no <html>: tokens do preset, accent, fonte e escala.
// A escala usa `zoom` no #root (index.css) — escala px fixos também, inclusive
// os de componentes de outros agentes (text-[11px] etc.).
export function applyTheme(t: ThemeSettings): void {
  const root = document.documentElement
  for (const k of ALL_TOKENS) root.style.removeProperty(k)
  for (const [k, v] of Object.entries(PRESETS[t.preset].tokens)) root.style.setProperty(k, v)
  if (t.accent) root.style.setProperty('--color-amber', t.accent)
  root.style.setProperty('--font-mono', FONTS[t.font].stack)
  root.style.setProperty('--ui-zoom', String(clampScale(t.scale) / 100))
  root.dataset.theme = t.preset
  root.style.colorScheme = t.preset === 'claro' ? 'light' : 'dark'
}
