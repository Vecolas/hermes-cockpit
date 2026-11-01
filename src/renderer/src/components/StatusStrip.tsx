import { RegionView } from './panels/RegionView'

/** largura mínima de cada bloco da strip (px) */
const STRIP_MIN_PX = 220

// Strip inferior: blocos da região "strip" do registry (padrão: Hoje ·
// time-boxing / Tarefas / Inbox triada). Cada bloco é redimensionável, pode ser
// escondido (×), reordenado (◂ ▸) e reexibido pelo "+". Cada um cuida da própria
// fonte e do próprio erro. Janela estreita: rola na horizontal.
export function StatusStrip({ panels, onChange }: { panels: string[]; onChange: (ids: string[]) => void }) {
  return (
    <footer className="h-full min-h-0 overflow-x-auto overflow-y-hidden border-t border-edge bg-panel">
      <div className="h-full" style={{ minWidth: Math.max(1, panels.length) * STRIP_MIN_PX }}>
        <RegionView
          region="strip"
          ids={panels}
          orientation="horizontal"
          minPx={STRIP_MIN_PX}
          onChange={onChange}
          emptyText="strip vazia — use + para adicionar um bloco."
        />
      </div>
    </footer>
  )
}
