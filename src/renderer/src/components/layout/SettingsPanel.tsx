import { useEffect, useState } from 'react'
import {
  DEFAULT_REGIONS,
  PANELS,
  PANEL_BY_ID,
  REGION_LABELS,
  movePanel,
  togglePanel,
  type Region,
  type RegionLayout,
} from '../../lib/panels'
import {
  DEFAULT_THEME,
  FONTS,
  PRESETS,
  SCALE_MAX,
  SCALE_MIN,
  SCALE_STEP,
  clampScale,
  type FontId,
  type ThemePreset,
  type ThemeSettings,
} from '../../lib/theme'

interface Props {
  theme: ThemeSettings
  onTheme: (t: ThemeSettings) => void
  regions: RegionLayout
  onRegions: (r: RegionLayout) => void
  onResetRegions: () => void
  onResetSizes: () => void
  onClose: () => void
  initialTab?: 'aparencia' | 'paineis'
}

const PRESET_SWATCH: Record<ThemePreset, [string, string]> = {
  grafite: ['#101318', '#e8a33d'],
  fosforo: ['#0c120e', '#7ee787'],
  ambar: ['#140f09', '#ffb547'],
  claro: ['#ffffff', '#b86e00'],
}

// Painel de configurações (⚙ na topbar / ⌘,): tema, accent, fonte, escala
// (densidade) e layout dos painéis por região. Tudo aplica ao vivo.
export function SettingsPanel(p: Props) {
  const [tab, setTab] = useState<'aparencia' | 'paineis'>(p.initialTab ?? 'aparencia')
  const t = p.theme
  const set = (patch: Partial<ThemeSettings>) => p.onTheme({ ...t, ...patch })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [p])

  return (
    <div className="no-drag fixed inset-0 z-50 flex justify-end bg-void/50" onMouseDown={p.onClose}>
      <div
        role="dialog"
        aria-label="Configurações"
        className="flex h-full w-[min(380px,100vw)] flex-col border-l border-edge2 bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
          <span className="label">Configurações</span>
          <button
            type="button"
            onClick={p.onClose}
            className="ml-auto rounded px-2 text-faint hover:text-ink"
            aria-label="fechar"
          >
            ✕
          </button>
        </div>
        <div className="flex gap-1 border-b border-edge px-3 pt-2">
          {(
            [
              ['aparencia', 'Aparência'],
              ['paineis', 'Painéis'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`-mb-px rounded-t-md border px-3 py-1.5 text-[11px] ${
                tab === id ? 'border-edge2 border-b-panel bg-panel2 text-ink' : 'border-transparent text-faint hover:text-dim'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-[12px]">
          {tab === 'aparencia' ? (
            <>
              <Section titulo="Tema">
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(PRESETS) as ThemePreset[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => set({ preset: id })}
                      className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left ${
                        t.preset === id ? 'border-amber text-ink' : 'border-edge2 text-dim hover:text-ink'
                      }`}
                    >
                      <span
                        className="h-4 w-4 rounded-sm border border-edge2"
                        style={{
                          background: `linear-gradient(135deg, ${PRESET_SWATCH[id][0]} 55%, ${PRESET_SWATCH[id][1]} 55%)`,
                        }}
                      />
                      {PRESETS[id].label}
                    </button>
                  ))}
                </div>
              </Section>

              <Section titulo="Accent">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={t.accent ?? '#e8a33d'}
                    onChange={(e) => set({ accent: e.target.value })}
                    className="h-7 w-10 cursor-pointer rounded border border-edge2 bg-transparent"
                    aria-label="cor de acento"
                  />
                  <span className="text-dim">{t.accent ?? 'do tema'}</span>
                  {t.accent && (
                    <button type="button" onClick={() => set({ accent: null })} className="ml-auto text-[11px] text-faint hover:text-ink">
                      usar a do tema
                    </button>
                  )}
                </div>
              </Section>

              <Section titulo="Fonte">
                <select
                  value={t.font}
                  onChange={(e) => set({ font: e.target.value as FontId })}
                  className="w-full rounded border border-edge2 bg-void px-2 py-1.5 text-ink focus:border-amber focus:outline-none"
                >
                  {(Object.keys(FONTS) as FontId[]).map((id) => (
                    <option key={id} value={id}>
                      {FONTS[id].label}
                    </option>
                  ))}
                </select>
              </Section>

              <Section titulo={`Escala / densidade · ${t.scale}%`}>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => set({ scale: clampScale(t.scale - SCALE_STEP) })}
                    className="rounded border border-edge2 px-2 text-dim hover:text-ink"
                    aria-label="diminuir escala"
                  >
                    −
                  </button>
                  <input
                    type="range"
                    min={SCALE_MIN}
                    max={SCALE_MAX}
                    step={SCALE_STEP}
                    value={t.scale}
                    onChange={(e) => set({ scale: clampScale(Number(e.target.value)) })}
                    className="flex-1 accent-amber"
                    aria-label="escala da interface"
                  />
                  <button
                    type="button"
                    onClick={() => set({ scale: clampScale(t.scale + SCALE_STEP) })}
                    className="rounded border border-edge2 px-2 text-dim hover:text-ink"
                    aria-label="aumentar escala"
                  >
                    +
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-faint">atalhos: ⌘= aumenta · ⌘- diminui · ⌘0 volta a 100%</p>
              </Section>

              <button
                type="button"
                onClick={() => p.onTheme(DEFAULT_THEME)}
                className="rounded border border-edge2 px-3 py-1.5 text-[11px] text-dim hover:text-ink"
              >
                Restaurar aparência padrão
              </button>
            </>
          ) : (
            <>
              {(Object.keys(REGION_LABELS) as Region[]).map((region) => (
                <RegionEditor
                  key={region}
                  region={region}
                  regions={p.regions}
                  onRegions={p.onRegions}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={p.onResetRegions}
                  className="rounded border border-edge2 px-3 py-1.5 text-[11px] text-dim hover:text-ink"
                  title={`padrão: strip = ${DEFAULT_REGIONS.strip.join(', ')}; dock = ${DEFAULT_REGIONS.dock.join(', ')}`}
                >
                  Restaurar painéis padrão
                </button>
                <button
                  type="button"
                  onClick={p.onResetSizes}
                  className="rounded border border-edge2 px-3 py-1.5 text-[11px] text-dim hover:text-ink"
                >
                  Restaurar tamanhos
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="label mb-2">{titulo}</div>
      {children}
    </section>
  )
}

function RegionEditor({
  region,
  regions,
  onRegions,
}: {
  region: Region
  regions: RegionLayout
  onRegions: (r: RegionLayout) => void
}) {
  const active = regions[region]
  const inactive = PANELS.filter((def) => !active.includes(def.id))
  return (
    <Section titulo={REGION_LABELS[region]}>
      <ul className="space-y-1">
        {active.map((id, i) => {
          const def = PANEL_BY_ID[id]
          if (!def) return null
          return (
            <li key={id} className="flex items-center gap-2 rounded border border-edge px-2 py-1">
              <input
                type="checkbox"
                checked
                onChange={() => onRegions(togglePanel(regions, region, id))}
                className="accent-amber"
                aria-label={`remover ${def.titulo}`}
              />
              <span className="min-w-0 flex-1 truncate text-ink">{def.titulo}</span>
              <span className="text-[10px] text-faint">{def.fonte.join(' ') || 'sem fonte'}</span>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => onRegions(movePanel(regions, region, id, -1))}
                className="px-1 text-faint enabled:hover:text-ink disabled:opacity-30"
                aria-label="mover para antes"
              >
                ↑
              </button>
              <button
                type="button"
                disabled={i === active.length - 1}
                onClick={() => onRegions(movePanel(regions, region, id, 1))}
                className="px-1 text-faint enabled:hover:text-ink disabled:opacity-30"
                aria-label="mover para depois"
              >
                ↓
              </button>
            </li>
          )
        })}
        {inactive.map((def) => (
          <li key={def.id} className="flex items-center gap-2 px-2 py-1 text-dim">
            <input
              type="checkbox"
              checked={false}
              onChange={() => onRegions(togglePanel(regions, region, def.id))}
              className="accent-amber"
              aria-label={`adicionar ${def.titulo}`}
            />
            <span className="min-w-0 flex-1 truncate">{def.titulo}</span>
            <span className="text-[10px] text-faint">{def.fonte.join(' ') || 'sem fonte'}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}
