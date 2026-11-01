import { useCallback, useEffect, useState } from 'react'
import { hasMain, invoke } from '../../lib/ipc'
import { toast } from '../../lib/toast'
import { ConfirmButton } from '../chat/ConfirmButton'

// Espelho dos tipos de src/main/ipc/storage.ts (o renderer não importa do main).
type CleanKind = 'logs' | 'cache' | 'worktrees'
interface UsageCategory {
  id: string
  label: string
  group: 'dados' | 'profiles' | 'cockpit' | 'instalação' | 'outros'
  kb: number
  paths: string[]
  clean?: CleanKind
  note?: string
}
interface StorageUsage {
  root: string
  totalKb: number
  categories: UsageCategory[]
  errors: string[]
  at: string
}
interface CleanPreview {
  kind: CleanKind
  candidates: { path: string; kb: number; reason: string }[]
  totalKb: number
  rules: string
}
interface CleanResult {
  kind: CleanKind
  removed: number
  freedKb: number
  errors: string[]
}

export function fmtKb(kb: number): string {
  if (kb < 1024) return `${kb} KB`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(kb < 10 * 1024 ? 1 : 0)} MB`
  return `${(kb / 1024 / 1024).toFixed(2)} GB`
}

const GROUP_LABEL: Record<UsageCategory['group'], string> = {
  dados: 'Dados do Hermes',
  profiles: 'Profiles (bots)',
  cockpit: 'Cockpit',
  instalação: 'Instalação',
  outros: 'Outros',
}
const GROUP_ORDER: UsageCategory['group'][] = ['dados', 'profiles', 'cockpit', 'instalação', 'outros']
const BAR: Record<UsageCategory['group'], string> = {
  dados: 'bg-amber/70',
  profiles: 'bg-cyanic/60',
  cockpit: 'bg-phos/60',
  instalação: 'bg-edge2',
  outros: 'bg-faint/60',
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Uso de disco de ~/.hermes por categoria (main: storage:usage → du -sk) com barras
// proporcionais e limpeza segura só para logs antigos, caches e worktrees de runs
// terminadas (preview obrigatório antes do 2º clique).
export function DiskUsage() {
  const [data, setData] = useState<StorageUsage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<Partial<Record<CleanKind, CleanPreview | 'loading' | { error: string }>>>({})

  const load = useCallback(async () => {
    if (!hasMain()) {
      setError('uso de disco indisponível fora do app (sem main process)')
      return
    }
    setLoading(true)
    setError(null)
    try {
      setData(await invoke<StorageUsage>('storage:usage'))
    } catch (e) {
      setError(errText(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const loadPreview = async (kind: CleanKind) => {
    setPreview((p) => ({ ...p, [kind]: 'loading' }))
    try {
      const pv = await invoke<CleanPreview>('storage:preview', kind)
      setPreview((p) => ({ ...p, [kind]: pv }))
    } catch (e) {
      setPreview((p) => ({ ...p, [kind]: { error: errText(e) } }))
    }
  }

  const doClean = async (kind: CleanKind) => {
    try {
      const r = await invoke<CleanResult>('storage:clean', kind)
      toast({
        title: `Limpeza de ${kind}: ${r.removed} ${kind === 'worktrees' ? 'worktree(s)' : 'arquivo(s)'}`,
        detail: `${fmtKb(r.freedKb)} liberados${r.errors.length ? ` · ${r.errors.length} erro(s): ${r.errors[0]}` : ''}`,
        tone: r.errors.length ? 'warn' : 'ok',
      })
      setPreview((p) => ({ ...p, [kind]: undefined }))
      void load()
    } catch (e) {
      toast({ title: 'Limpeza falhou', detail: errText(e), tone: 'error' })
    }
  }

  const max = data ? Math.max(1, ...data.categories.map((c) => c.kb)) : 1

  return (
    <section className="rounded-lg border border-edge bg-panel/60">
      <header className="flex items-center gap-2 border-b border-edge px-3 py-2">
        <span className="label">Disco · ~/.hermes</span>
        {data && <span className="text-[12px] text-ink">{fmtKb(data.totalKb)}</span>}
        {data && <span className="text-[10px] text-faint">medido {new Date(data.at).toLocaleTimeString('pt-BR')}</span>}
        <button
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto rounded border border-edge px-2 py-0.5 text-[11px] text-dim hover:border-amber/50 hover:text-ink disabled:opacity-50"
        >
          {loading ? 'medindo…' : '↻ medir'}
        </button>
      </header>
      {error && <div className="m-3 rounded border border-alert/40 px-3 py-2 text-[11.5px] text-alert">{error}</div>}
      {!data && !error && (
        <div className="space-y-2 p-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="hc-shimmer h-5 rounded" />
          ))}
        </div>
      )}
      {data && (
        <div className="space-y-3 p-3">
          {/* barra empilhada do total */}
          <div className="flex h-2 overflow-hidden rounded-full bg-void" title="proporção por grupo">
            {GROUP_ORDER.map((g) => {
              const kb = data.categories.filter((c) => c.group === g).reduce((s, c) => s + c.kb, 0)
              return kb ? <div key={g} className={BAR[g]} style={{ width: `${(kb / Math.max(1, data.totalKb)) * 100}%` }} title={`${GROUP_LABEL[g]} · ${fmtKb(kb)}`} /> : null
            })}
          </div>
          {GROUP_ORDER.map((g) => {
            const cats = data.categories.filter((c) => c.group === g).sort((a, b) => b.kb - a.kb)
            if (!cats.length) return null
            return (
              <div key={g}>
                <div className="label mb-1 text-[9.5px]">{GROUP_LABEL[g]}</div>
                <div className="space-y-1">
                  {cats.map((c) => {
                    const pv = c.clean ? preview[c.clean] : undefined
                    return (
                      <div key={c.id} className="group">
                        <div className="flex items-center gap-2 text-[11.5px]">
                          <span className="w-44 shrink-0 truncate text-ink/90" title={c.paths.join('\n')}>
                            {c.label}
                          </span>
                          <div className="relative h-3 min-w-0 flex-1 overflow-hidden rounded-sm bg-void">
                            <div className={`hc-fade-in h-full ${BAR[g]}`} style={{ width: `${Math.max(0.5, (c.kb / max) * 100)}%` }} />
                          </div>
                          <span className="w-16 shrink-0 text-right tabular-nums text-dim">{fmtKb(c.kb)}</span>
                          <span className="w-24 shrink-0 text-right">
                            {c.clean && !pv && (
                              <button
                                onClick={() => void loadPreview(c.clean as CleanKind)}
                                className="rounded border border-edge px-1.5 py-px text-[10.5px] text-dim hover:border-amber/50 hover:text-ink"
                              >
                                limpar…
                              </button>
                            )}
                            {pv === 'loading' && <span className="text-[10.5px] text-faint">analisando…</span>}
                          </span>
                        </div>
                        {c.note && <div className="ml-[11.5rem] text-[10px] text-faint">{c.note}</div>}
                        {pv && pv !== 'loading' && c.clean && (
                          <div className="hc-fade-in ml-[11.5rem] mt-1 rounded border border-dashed border-edge2 px-2 py-1.5 text-[11px]">
                            {'error' in pv ? (
                              <span className="text-alert">{pv.error}</span>
                            ) : (
                              <>
                                <div className="text-faint">{pv.rules}</div>
                                {pv.candidates.length === 0 ? (
                                  <div className="mt-1 text-dim">nada para limpar com essas regras.</div>
                                ) : (
                                  <>
                                    <ul className="mt-1 max-h-28 space-y-px overflow-y-auto font-mono text-[10.5px] text-dim">
                                      {pv.candidates.slice(0, 40).map((x) => (
                                        <li key={x.path} className="flex gap-2">
                                          <span className="min-w-0 flex-1 truncate" title={x.path}>
                                            {x.path.replace(data.root, '~/.hermes')}
                                          </span>
                                          <span className="shrink-0 text-faint">{x.reason}</span>
                                          <span className="w-14 shrink-0 text-right">{fmtKb(x.kb)}</span>
                                        </li>
                                      ))}
                                      {pv.candidates.length > 40 && <li className="text-faint">… +{pv.candidates.length - 40}</li>}
                                    </ul>
                                    <div className="mt-1.5 flex items-center gap-2">
                                      <ConfirmButton onConfirm={() => doClean(c.clean as CleanKind)} confirmLabel={`confirmar: apagar ${pv.candidates.length}`}>
                                        limpar {pv.candidates.length} · {fmtKb(pv.totalKb)}
                                      </ConfirmButton>
                                    </div>
                                  </>
                                )}
                              </>
                            )}
                            <button
                              onClick={() => setPreview((p) => ({ ...p, [c.clean as CleanKind]: undefined }))}
                              className="mt-1 text-[10.5px] text-faint hover:text-ink"
                            >
                              cancelar
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {data.errors.length > 0 && <div className="text-[10.5px] text-amber">{data.errors.join(' · ')}</div>}
        </div>
      )}
    </section>
  )
}
