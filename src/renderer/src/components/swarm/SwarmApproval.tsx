import { useState } from 'react'
import { errMsg, refreshSwarm, runHandle, swarmApi, type Approval, type RunMeta } from '../../lib/swarm'
import { toast } from '../../lib/toast'
import { prettyJson, summarizeInput } from './ui'

// Card de aprovação de ferramenta do Claude Code (perm.mjs → arquivo → cockpit).
// Mesmo idioma visual do ApprovalCard do chat: âmbar tracejado.

export function SwarmApprovalCard({
  approval,
  run,
  compact = false,
  onSelectRun,
}: {
  approval: Approval
  run?: RunMeta
  compact?: boolean
  onSelectRun?: (runId: string) => void
}) {
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [showReason, setShowReason] = useState(false)
  const [expanded, setExpanded] = useState(!compact)

  const decide = async (d: 'allow' | 'deny') => {
    setBusy(d)
    setError(null)
    try {
      await swarmApi.decide(approval.id, d, reason.trim() || undefined)
      toast({ title: d === 'allow' ? 'Aprovado' : 'Negado', detail: approval.toolName, tone: d === 'allow' ? 'ok' : 'info' })
      void refreshSwarm()
    } catch (e) {
      setError(errMsg(e))
      setBusy(null)
    }
  }

  const summary = summarizeInput(approval.toolName, approval.input)

  return (
    <div className="hc-rise rounded-lg border border-dashed border-amber/70 bg-amber/[0.04] px-3.5 py-2.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-bold text-amber glow-amber">!</span>
        <span className="shrink-0 text-[12px] text-ink">Aprovação pendente</span>
        <span className="min-w-0 truncate text-[12px] text-amber">· {approval.toolName}</span>
        {run && (
          <button
            type="button"
            onClick={() => onSelectRun?.(run.id)}
            className="ml-auto shrink-0 text-[10.5px] text-dim hover:text-ink"
            title={run.title || run.task}
          >
            {runHandle(run)}
          </button>
        )}
      </div>
      {summary && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 block w-full truncate text-left text-[11.5px] text-dim hover:text-ink"
          title="ver input completo"
        >
          {summary}
        </button>
      )}
      {expanded && (
        <pre className="hc-fade-in mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-void px-2.5 py-1.5 text-[11px] text-ink/90">
          {prettyJson(approval.input)}
        </pre>
      )}
      {showReason && (
        <input
          autoFocus
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="motivo (opcional, vai ao claude)"
          className="mt-2 w-full rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
        />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => decide('allow')}
          className="rounded bg-amber px-3 py-1 text-[11.5px] font-semibold text-void hover:brightness-110 disabled:opacity-50"
        >
          {busy === 'allow' ? 'Aprovando…' : 'Aprovar'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => decide('deny')}
          className="rounded border border-edge2 px-3 py-1 text-[11.5px] text-ink hover:border-alert hover:text-alert disabled:opacity-50"
        >
          {busy === 'deny' ? 'Negando…' : 'Negar'}
        </button>
        {!showReason && (
          <button type="button" onClick={() => setShowReason(true)} className="text-[10.5px] text-faint hover:text-dim">
            + motivo
          </button>
        )}
        {error && <span className="text-[11px] text-alert">{error}</span>}
      </div>
    </div>
  )
}
