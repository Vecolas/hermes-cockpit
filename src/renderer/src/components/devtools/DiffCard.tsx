import { api } from '../../lib/ipc'
import {
  apiPath,
  basename,
  parseDiff,
  requestDiffFocus,
  requestDockTab,
  useResource,
  useWorkspace,
  type GitStatus,
  type ReviewFile,
} from '../../lib/devtools'
import type { WidgetProps } from '../panels/widgets'
import { PanelFrame } from '../panels/PanelFrame'

// Card 'Diff pendente' do registry: git status real do workspace ativo (o
// mesmo do dock) + amostra de 2–3 linhas +/- do arquivo com mais mudanças.
// "Revisar" abre a aba Diff · Git focada nesse arquivo (evento hc:dock-tab).
// CONTRATO: nome do export e props são fixos (App/registry já montam assim).

export function DiffCard({ refreshMs }: WidgetProps) {
  const ws = useWorkspace()
  const root = ws.path
  const status = useResource<GitStatus | null>(
    root ? `dc-st:${root}` : null,
    () => api<GitStatus | null>(apiPath('/api/git/status', { path: root! })),
    refreshMs,
  )
  const repo = status.data ?? null
  const list = useResource<{ files: ReviewFile[] }>(
    root && repo && repo.changed > 0 ? `dc-rl:${root}:${repo.changed}:${repo.added}:${repo.removed}` : null,
    () => api(apiPath('/api/git/review/list', { path: root!, scope: 'uncommitted' })),
  )
  const files = list.data?.files ?? []
  const top = files.length ? [...files].sort((a, b) => b.added + b.removed - (a.added + a.removed))[0] : null
  const diff = useResource<{ diff: string }>(
    root && top ? `dc-df:${root}:${top.path}:${top.added}:${top.removed}` : null,
    () => api(apiPath('/api/git/file-diff', { path: root!, file: top!.path })),
  )
  const sample = diff.data ? parseDiff(diff.data.diff).filter((l) => l.kind === 'add' || l.kind === 'del').slice(0, 3) : []

  const review = () => {
    if (top) requestDiffFocus(top.path)
    requestDockTab('diff')
  }

  const error = status.error ?? list.error ?? (ws.error && !root ? ws.error : null)

  return (
    <PanelFrame
      titulo="Diff pendente"
      fonte={root ? basename(root) : '/api/git/status'}
      error={error}
      loading={!root ? ws.loading : status.data === undefined && !status.error}
      empty={status.data === null || (repo !== null && repo.changed === 0)}
      emptyText={status.data === null ? 'workspace não é um repo git.' : 'árvore limpa — nada pendente.'}
      onRefresh={() => {
        status.refresh()
        list.refresh()
        diff.refresh()
      }}
    >
      {repo && (
        <div className="flex min-h-0 flex-col gap-2 text-[11px]">
          <div className="flex items-baseline gap-2">
            <span className="text-amber">{repo.detached ? '(detached)' : repo.branch ?? '?'}</span>
            <span className="text-faint">
              {repo.changed} arquivo(s) · <span className="text-phos">+{repo.added}</span> <span className="text-alert">−{repo.removed}</span>
            </span>
          </div>

          {top && (
            <div className="min-w-0 rounded border border-edge bg-void/60">
              <div className="flex items-center gap-2 border-b border-edge px-2 py-1 text-[10px]">
                <span className="truncate text-dim" title={top.path}>
                  {top.path}
                </span>
                <span className="ml-auto shrink-0">
                  <span className="text-phos">+{top.added}</span> <span className="text-alert">−{top.removed}</span>
                </span>
              </div>
              <div className="overflow-hidden font-mono text-[10.5px] leading-[1.5]">
                {diff.error ? (
                  <div className="px-2 py-1 text-alert">diff indisponível: {diff.error}</div>
                ) : !diff.data ? (
                  <div className="hc-shimmer px-2 py-1 text-faint">carregando…</div>
                ) : sample.length === 0 ? (
                  <div className="px-2 py-1 text-faint">sem linhas de texto (binário/renomeado).</div>
                ) : (
                  sample.map((l, i) => (
                    <div key={i} className={`truncate whitespace-pre px-2 ${l.kind === 'add' ? 'bg-phos/10 text-phos' : 'bg-alert/10 text-alert'}`}>
                      {l.kind === 'add' ? '+ ' : '- '}
                      {l.text}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <div className="flex gap-1">
            <button
              type="button"
              onClick={review}
              className="rounded border border-amber/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber hover:bg-amber/10"
            >
              Revisar
            </button>
            {files.length > 1 && <span className="self-center text-[10px] text-faint">+{files.length - 1} outro(s)</span>}
          </div>
        </div>
      )}
    </PanelFrame>
  )
}
