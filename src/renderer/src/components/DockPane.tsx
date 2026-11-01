import { useState } from 'react'

const TABS = ['Terminal', 'Diff · Git', 'Preview', 'Arquivos'] as const

type Tab = (typeof TABS)[number]

const HINTS: Record<Tab, string> = {
  Terminal: 'xterm.js sobre o endpoint /api/pty do serve — mesma técnica do dashboard oficial.',
  'Diff · Git': 'git_probe do backend + render de diff por arquivo, com Revisar/Commit.',
  Preview: 'screenshot ao vivo da tela do Mac (operador bounded).',
  Arquivos: 'navegador de arquivos do workspace da sessão ativa.',
}

export function DockPane() {
  const [tab, setTab] = useState<Tab>('Terminal')

  return (
    <aside className="flex h-full flex-col border-l border-edge bg-panel">
      <div className="flex border-b border-edge">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 border-b-2 px-2 py-2.5 text-[11px] transition-colors ${
              tab === t
                ? 'border-amber text-ink'
                : 'border-transparent text-faint hover:text-dim'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="label">{tab}</div>
        <p className="text-[12px] leading-relaxed text-dim">{HINTS[tab]}</p>
        <span className="rounded border border-edge2 px-2 py-1 text-[10px] text-faint">v2</span>
      </div>
    </aside>
  )
}
