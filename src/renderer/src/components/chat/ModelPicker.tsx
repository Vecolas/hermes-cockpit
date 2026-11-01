import { useEffect, useMemo, useState } from 'react'
import type { HermesRpc } from '../../lib/rpc'
import { modelOptions, switchModel, type ModelOptions } from '../../lib/gateway'

interface Props {
  rpc: HermesRpc
  profile: string
  /** id runtime da sessão ativa — o gateway só troca modelo com sessão viva */
  sessionId: string | null
  currentModel: string | null
  currentProvider: string | null
  onClose: () => void
  onSwitched: (note: string) => void
}

// Popover do chip "modelo: X · fallback Y". Lista via model.options; troca via
// config.set {key:"model", value:"<model> --provider <p> --global|--session"}.
export function ModelPicker({ rpc, profile, sessionId, currentModel, currentProvider, onClose, onSwitched }: Props) {
  const [opts, setOpts] = useState<ModelOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [persist, setPersist] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ model: string; provider: string; message: string } | null>(null)

  useEffect(() => {
    let alive = true
    modelOptions(rpc, { profile, sessionId: sessionId ?? undefined })
      .then((o) => alive && setOpts(o))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [rpc, profile, sessionId])

  const providers = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (opts?.providers ?? [])
      .filter((p) => p.authenticated !== false)
      .map((p) => ({ ...p, models: f ? p.models.filter((m) => m.toLowerCase().includes(f) || p.slug.includes(f)) : p.models }))
      .filter((p) => p.models.length > 0)
  }, [opts, filter])

  const apply = async (model: string, provider: string, confirmed = false) => {
    if (!sessionId) return
    setBusy(`${provider}/${model}`)
    setError(null)
    try {
      const res = await switchModel(rpc, { sessionId, profile, model, provider, persist, confirm: confirmed })
      if (res.confirm_required) {
        setConfirm({ model, provider, message: res.confirm_message || 'Modelo caro — confirmar troca?' })
        return
      }
      const scope = persist ? 'default do profile' : 'só nesta sessão'
      const parts = [`modelo → ${model} (${provider}) · ${scope}`]
      if (res.deferred) parts.push('aplica no próximo turno')
      if (res.warning) parts.push(res.warning)
      onSwitched(parts.join(' · '))
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const current = opts?.model || currentModel
  const currentProv = opts?.provider || currentProvider

  return (
    <div className="absolute left-0 top-full z-30 mt-1 w-[420px] max-w-[80vw] rounded-lg border border-edge2 bg-panel shadow-2xl">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="label">Modelo · {profile}</span>
        <button onClick={onClose} className="text-faint hover:text-ink" aria-label="fechar">
          ✕
        </button>
      </div>
      <div className="space-y-2 px-3 py-2">
        <div className="text-[11.5px] text-dim">
          atual: <span className="text-ink">{current ?? '—'}</span>
          {currentProv && <span className="text-faint"> · {currentProv}</span>}
        </div>
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filtrar modelos…"
          className="w-full rounded border border-edge bg-void px-2 py-1 text-[12px] text-ink focus:border-amber focus:outline-none"
        />
        <label className="flex items-center gap-2 text-[11px] text-dim">
          <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} className="accent-amber" />
          gravar como default do profile (--global)
        </label>
        {!sessionId && <div className="text-[11px] text-amber">sem sessão viva — a troca exige o chat aberto</div>}
        {error && <div className="text-[11px] text-alert">{error}</div>}
        {confirm && (
          <div className="rounded border border-dashed border-amber/60 px-2 py-1.5 text-[11.5px]">
            <div className="text-amber">{confirm.message}</div>
            <div className="mt-1.5 flex gap-2">
              <button
                onClick={() => {
                  const c = confirm
                  setConfirm(null)
                  void apply(c.model, c.provider, true)
                }}
                className="rounded bg-amber px-2 py-0.5 text-[11px] font-semibold text-void"
              >
                confirmar
              </button>
              <button onClick={() => setConfirm(null)} className="rounded border border-edge2 px-2 py-0.5 text-[11px] text-dim">
                cancelar
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="max-h-80 overflow-y-auto border-t border-edge py-1">
        {!opts && !error && <div className="px-3 py-2 text-[12px] text-faint">carregando modelos…</div>}
        {opts && providers.length === 0 && <div className="px-3 py-2 text-[12px] text-faint">nenhum modelo disponível</div>}
        {providers.map((p) => (
          <div key={p.slug} className="py-1">
            <div className="label px-3 py-0.5">
              {p.name || p.slug}
              {p.warning ? <span className="ml-2 normal-case tracking-normal text-amber">{p.warning}</span> : null}
            </div>
            {p.models.map((m) => {
              const active = m === current && p.slug === currentProv
              const key = `${p.slug}/${m}`
              return (
                <button
                  key={key}
                  disabled={!sessionId || busy !== null}
                  onClick={() => void apply(m, p.slug)}
                  className={`flex w-full items-center justify-between px-3 py-0.5 text-left text-[12px] hover:bg-panel2 disabled:cursor-not-allowed disabled:opacity-60 ${
                    active ? 'text-amber' : 'text-ink'
                  }`}
                >
                  <span className="truncate">{m}</span>
                  {busy === key ? <span className="text-faint">…</span> : active ? <span className="text-[10px]">atual</span> : null}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
