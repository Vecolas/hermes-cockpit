import { PANEL_BY_ID } from '../lib/panels'
import { ErrorBoundary } from './ErrorBoundary'

// Strip inferior: renderiza os painéis da região "strip" do registry
// (padrão: Hoje · time-boxing / Tarefas / Inbox triada). Cada painel cuida da
// própria fonte e do próprio erro (polling via components/panels/source.tsx).
// Em janela estreita, rola na horizontal (cada painel tem largura mínima).
export function StatusStrip({ panels }: { panels: string[] }) {
  const defs = panels.map((id) => PANEL_BY_ID[id]).filter(Boolean)
  return (
    <footer className="flex h-full min-h-0 overflow-x-auto overflow-y-hidden border-t border-edge bg-panel">
      {defs.length === 0 && (
        <div className="px-4 py-3 text-[11px] text-faint">strip vazia — configure em ⚙ → Painéis.</div>
      )}
      {defs.map((def) => {
        const C = def.componente
        return (
          <div
            key={def.id}
            className="h-full min-w-[300px] flex-1 basis-0 border-r border-edge last:border-r-0"
          >
            <ErrorBoundary label={def.titulo}>
              <C refreshMs={def.refreshMs} />
            </ErrorBoundary>
          </div>
        )
      })}
    </footer>
  )
}
