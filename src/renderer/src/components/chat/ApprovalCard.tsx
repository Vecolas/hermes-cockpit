import { useState } from 'react'
import type { ApprovalChoice } from '../../lib/gateway'
import type { PendingApproval } from '../../lib/chat-store'

interface Props {
  approval: PendingApproval
  onRespond: (approval: PendingApproval, choice: ApprovalChoice) => Promise<void>
}

const EXTRA_LABEL: Partial<Record<ApprovalChoice, string>> = {
  session: 'Aprovar na sessão',
  always: 'Sempre',
}

// Card "! Aprovação pendente" do wireframe: borda tracejada âmbar, Aprovar / Negar.
// A resposta vai ao backend (server request `approval` ou approval.respond).
export function ApprovalCard({ approval, onRespond }: Props) {
  const [busy, setBusy] = useState<ApprovalChoice | null>(null)
  const [error, setError] = useState<string | null>(null)
  const r = approval.request
  const choices = (r.choices?.length ? r.choices : ['once', 'deny']) as ApprovalChoice[]
  const extras = choices.filter((c) => c === 'session' || c === 'always')

  const act = async (choice: ApprovalChoice) => {
    setBusy(choice)
    setError(null)
    try {
      await onRespond(approval, choice)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-amber/70 bg-amber/[0.04] px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-bold text-amber glow-amber">!</span>
        <span className="text-ink">
          Aprovação pendente
          {r.tool_name ? <span className="text-dim"> · {r.tool_name}</span> : null}
        </span>
      </div>
      {r.description && <p className="mt-1 text-[12px] text-dim">{r.description}</p>}
      {r.command && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-edge bg-void px-3 py-2 text-[11.5px] text-ink/90">
          {r.command}
        </pre>
      )}
      {r.smart_denied && (
        <p className="mt-1 text-[11px] text-alert">o avaliador automático recomendou negar</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          disabled={busy !== null}
          onClick={() => act('once')}
          className="rounded bg-amber px-3 py-1.5 text-[12px] font-semibold text-void hover:brightness-110 disabled:opacity-50"
        >
          {busy === 'once' ? 'Aprovando…' : 'Aprovar'}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => act('deny')}
          className="rounded border border-edge2 px-3 py-1.5 text-[12px] text-ink hover:border-alert hover:text-alert disabled:opacity-50"
        >
          {busy === 'deny' ? 'Negando…' : 'Negar'}
        </button>
        {extras.map((c) => (
          <button
            key={c}
            disabled={busy !== null}
            onClick={() => act(c)}
            className="rounded border border-edge px-2.5 py-1.5 text-[11px] text-dim hover:border-amber/60 hover:text-ink disabled:opacity-50"
          >
            {EXTRA_LABEL[c]}
          </button>
        ))}
        {error && <span className="text-[11px] text-alert">{error}</span>}
      </div>
    </div>
  )
}
