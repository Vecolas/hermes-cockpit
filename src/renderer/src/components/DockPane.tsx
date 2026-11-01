import { useRef } from 'react'
import { Group, Panel, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { GROUP_IDS, SIZES, safeStorage } from '../lib/layout'
import { RegionView } from './panels/RegionView'
import { ResizeHandle, useCollapseSync } from './layout/ResizeHandle'

export const DOCK_TABS = [
  {
    id: 'terminal',
    label: 'Terminal',
    hint: 'xterm.js sobre o endpoint /api/pty do serve — mesma técnica do dashboard oficial.',
    fase: 'P2-12',
  },
  {
    id: 'diff',
    label: 'Diff · Git',
    hint: 'git_probe do backend + diff por arquivo, com Revisar/Commit.',
    fase: 'P2-13',
  },
  {
    id: 'preview',
    label: 'Preview',
    hint: 'preview do que o bot está construindo (URL local / build).',
    fase: 'P2-14',
  },
  {
    id: 'arquivos',
    label: 'Arquivos',
    hint: 'navegador de arquivos do workspace da sessão ativa.',
    fase: 'P2',
  },
  {
    id: 'tela',
    label: 'Tela Mac',
    hint: 'screenshot ao vivo da tela do Mac (computer use / operador bounded).',
    fase: 'P2-14',
  },
] as const

interface Props {
  tab: string
  onTabChange: (id: string) => void
  /** ids do registry de painéis para a área de cards (região "dock") */
  cards: string[]
  onCardsChange: (ids: string[]) => void
  cardsOpen: boolean
  onCardsOpenChange: (open: boolean) => void
}

// Dock lateral: abas (P2 ainda — conteúdo honesto "em breve") em cima e cards
// do registry embaixo, com alça vertical redimensionável/colapsável.
export function DockPane({ tab, onTabChange, cards, onCardsChange, cardsOpen, onCardsOpenChange }: Props) {
  const current = DOCK_TABS.find((t) => t.id === tab) ?? DOCK_TABS[0]
  const cardsRef = usePanelRef()
  const layout = useDefaultLayout({
    id: GROUP_IDS.dock,
    storage: safeStorage,
    onlySaveAfterUserInteractions: true,
  })
  const wantOpen = useRef(cardsOpen)
  wantOpen.current = cardsOpen

  // Sincroniza preferência (botão/atalho) → painel.
  useCollapseSync(cardsRef, cardsOpen)


  return (
    <aside className="flex h-full min-w-0 flex-col bg-panel">
      <div className="flex shrink-0 flex-wrap gap-1 border-b border-edge px-2 pt-2" role="tablist">
        {DOCK_TABS.map((t) => {
          const on = t.id === current.id
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onTabChange(t.id)}
              className={`-mb-px rounded-t-md border px-3 py-1.5 text-[11px] transition-colors ${
                on
                  ? 'border-edge2 border-b-panel bg-panel2 text-ink'
                  : 'border-transparent text-faint hover:text-dim'
              }`}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      <Group
        id={GROUP_IDS.dock}
        orientation="vertical"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={(l, meta) => {
          layout.onLayoutChanged(l, meta)
          // só arrasto/teclado do usuário muda a preferência (não o mount)
          if (meta.isUserInteraction && l['dock-cards'] !== undefined) {
            const open = l['dock-cards'] > 0.5
            if (open !== wantOpen.current) onCardsOpenChange(open)
          }
        }}
      >
        <Panel id="dock-tabs" minSize={SIZES.dockTabsMin}>
          <div className="flex h-full flex-col items-center justify-center gap-3 overflow-auto px-6 text-center">
            <div className="label">{current.label}</div>
            <p className="max-w-xs text-[12px] leading-relaxed text-dim">{current.hint}</p>
            <span className="rounded border border-edge2 px-2 py-1 text-[10px] text-faint">
              em breve ({current.fase})
            </span>
          </div>
        </Panel>
        <ResizeHandle
          orientation="vertical"
          title="arraste para redimensionar · duplo clique para recolher/expandir os cards"
          onToggle={() => onCardsOpenChange(!cardsOpen)}
        />
        <Panel
          id="dock-cards"
          panelRef={cardsRef}
          collapsible
          collapsedSize={0}
          defaultSize={SIZES.dockCards.default}
          minSize={SIZES.dockCards.min}
          groupResizeBehavior="preserve-pixel-size"
        >
          <div className="h-full border-t border-edge">
            <RegionView
              region="dock"
              ids={cards}
              orientation="vertical"
              minPx={72}
              onChange={onCardsChange}
              emptyText="nenhum card aqui — use + para adicionar um bloco."
            />
          </div>
        </Panel>
      </Group>
    </aside>
  )
}
