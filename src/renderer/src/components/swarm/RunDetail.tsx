import { useRef, useState } from 'react'
import { nextStep, retryRun } from '../../lib/flow'
import { invoke } from '../../lib/ipc'
import {
  errMsg,
  fmtDuration,
  isActive,
  refreshSwarm,
  repoName,
  runElapsedMs,
  STATUS_LABEL,
  STATUS_TONE,
  swarmApi,
  useNow,
  useRunEvents,
  type Approval,
  type RunMeta,
} from '../../lib/swarm'
import { fmtRunTokens, tokenBreakdown } from '../../lib/swarm-tokens'
import { toast } from '../../lib/toast'
import { RunDiff } from './RunDiff'
import { RunStream } from './RunStream'
import { SwarmApprovalCard } from './SwarmApproval'
import { FlowRail, NextStepBanner } from './flow'
import { Btn, ConfirmButton, StatusDot } from './ui'

// Centro da SwarmView (e versão compacta no dock): cabeçalho com ações, stream
// ou diff, aprovações pendentes da run e "continuar conversa".

type OpenTarget = { kind: 'finder' | 'vscode' | 'terminal' | 'url'; path?: string; url?: string }

async function openIn(target: OpenTarget): Promise<void> {
  try {
    await invoke<void>('ops:open', target)
  } catch (e) {
    toast({ title: 'Não foi possível abrir', detail: errMsg(e), tone: 'error' })
  }
}

export function RunDetail({
  run,
  approvals,
  compact = false,
  onSelectRun,
}: {
  run: RunMeta
  approvals: Approval[]
  compact?: boolean
  onSelectRun: (id: string) => void
}) {
  const active = isActive(run.status)
  const ev = useRunEvents(run.id, active)
  const now = useNow(1000, active)
  const [tab, setTab] = useState<'stream' | 'diff'>('stream')
  const [msg, setMsg] = useState('')
  const [sending, setSending] = useState(false)
  const mine = approvals.filter((a) => a.runId === run.id)
  const approvalsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const next = nextStep(run, approvals)
  const [retrying, setRetrying] = useState(false)

  const runCta = async () => {
    if (next.cta === 'approve' || next.cta === 'answer') {
      const el = approvalsRef.current
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      el?.querySelector<HTMLElement>('button, input, textarea')?.focus({ preventScroll: true })
    } else if (next.cta === 'review') setTab('diff')
    else if (next.cta === 'continue') inputRef.current?.focus()
    else if (next.cta === 'retry') {
      setRetrying(true)
      const made = await retryRun(run)
      setRetrying(false)
      if (made) onSelectRun(made.id)
    }
  }

  const send = async () => {
    const text = msg.trim()
    if (!text) return
    setSending(true)
    try {
      const next = await swarmApi.send(run.id, text)
      setMsg('')
      void refreshSwarm()
      if (next?.id) onSelectRun(next.id)
    } catch (e) {
      toast({ title: 'Falha ao continuar a conversa', detail: errMsg(e), tone: 'error' })
    } finally {
      setSending(false)
    }
  }

  const canSend = !active && Boolean(run.claudeSessionId)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* cabeçalho */}
      <div className={`border-b border-edge ${compact ? 'px-3 py-2' : 'px-5 py-3'}`}>
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status={run.status} />
          <span className={`min-w-0 flex-1 truncate text-ink ${compact ? 'text-[11.5px]' : 'text-[13px]'}`} title={run.task}>
            {run.title || run.task}
          </span>
          <span key={run.status} className={`hc-pop shrink-0 text-[10.5px] ${STATUS_TONE[run.status].text}`}>{STATUS_LABEL[run.status]}</span>
        </div>
        <FlowRail run={run} approvals={approvals} compact={compact} className={compact ? 'mt-2' : 'mt-3 px-1'} />
        <div className={compact ? 'mt-2' : 'mt-3'}>
          <NextStepBanner
            step={next}
            compact={compact}
            action={
              next.cta !== 'none' && next.ctaLabel && !(compact && next.cta === 'review') ? (
                <button
                  type="button"
                  onClick={() => void runCta()}
                  disabled={retrying}
                  className={`hc-press shrink-0 rounded-md border px-3 py-1 text-[11px] font-semibold disabled:opacity-50 ${
                    next.tone === 'you'
                      ? 'border-amber/70 bg-amber text-void hover:brightness-110'
                      : next.tone === 'bad'
                        ? 'border-alert/60 text-alert hover:bg-alert/10'
                        : 'border-edge2 text-ink hover:border-amber/60'
                  }`}
                >
                  {retrying ? '…' : next.ctaLabel}
                </button>
              ) : undefined
            }
          />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px] text-faint">
          <span title={run.repo}>{repoName(run.repo)}</span>
          {run.branch && <span className="text-dim">⎇ {run.branch}</span>}
          {run.model && <span>{run.model}</span>}
          {run.permissionMode && run.permissionMode !== 'manual' && (
            <span className={run.permissionMode === 'bypass' ? 'text-alert' : 'text-phos'}>perm: {run.permissionMode}</span>
          )}
          <span>{fmtDuration(runElapsedMs(run, now))}</span>
          {run.numTurns != null && <span>{run.numTurns} turnos</span>}
          {run.tokensTotal != null && (
            <span title={tokenBreakdown(run)}>{fmtRunTokens(run.tokensTotal)}</span>
          )}
          {run.requestedBy && (
            <span>
              via {run.requestedBy.via}
              {run.requestedBy.profile ? ` · @${run.requestedBy.profile}` : ''}
            </span>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {!compact && (
            <div className="mr-1 flex rounded border border-edge2 p-0.5">
              {(['stream', 'diff'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`rounded px-2 py-0.5 text-[10.5px] uppercase tracking-[0.12em] transition-colors ${
                    tab === t ? 'bg-panel2 text-ink' : 'text-faint hover:text-dim'
                  }`}
                >
                  {t === 'stream' ? 'stream' : 'diff'}
                </button>
              ))}
            </div>
          )}
          <Btn onClick={() => void openIn({ kind: 'finder', path: run.cwd })} title={run.cwd}>
            Finder
          </Btn>
          <Btn onClick={() => void openIn({ kind: 'vscode', path: run.cwd })} title={run.cwd}>
            VS Code
          </Btn>
          {!compact && (
            <Btn onClick={() => void openIn({ kind: 'terminal', path: run.cwd })} title={run.cwd}>
              Terminal
            </Btn>
          )}
          <span className="ml-auto" />
          {active && (
            <ConfirmButton
              label="Cancelar run"
              confirmLabel="cancelar mesmo?"
              title="SIGTERM no runner e no claude"
              onConfirm={async () => {
                try {
                  await swarmApi.cancel(run.id)
                  toast({ title: 'Run cancelada', tone: 'info' })
                  void refreshSwarm()
                } catch (e) {
                  toast({ title: 'Falha ao cancelar', detail: errMsg(e), tone: 'error' })
                }
              }}
            />
          )}
          {!active && run.cwd !== run.repo && (
            <ConfirmButton
              label="Limpar worktree"
              confirmLabel="remover worktree + branch?"
              title={`remove ${run.cwd} e a branch ${run.branch ?? ''}`}
              onConfirm={async () => {
                try {
                  await swarmApi.cleanup(run.id)
                  toast({ title: 'Worktree removido', detail: run.branch, tone: 'ok' })
                  void refreshSwarm()
                } catch (e) {
                  toast({ title: 'Falha ao limpar', detail: errMsg(e), tone: 'error' })
                }
              }}
            />
          )}
        </div>
      </div>

      {/* corpo */}
      {tab === 'diff' && !compact ? (
        <RunDiff cwd={run.cwd} />
      ) : (
        <RunStream lines={ev.lines} loading={ev.loading} error={ev.error} compact={compact} live={active} />
      )}

      {/* aprovações desta run */}
      {mine.length > 0 && (
        <div ref={approvalsRef} className={`space-y-2 border-t border-amber/20 ${compact ? 'max-h-[45%] overflow-y-auto px-3 py-2' : 'px-5 py-3'}`}>
          {mine.map((a) => (
            <SwarmApprovalCard key={a.id} approval={a} compact={compact} />
          ))}
        </div>
      )}

      {/* continuar conversa */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
        className={`flex items-center gap-2 border-t border-edge ${compact ? 'px-3 py-2' : 'px-5 py-2.5'}`}
      >
        <input
          ref={inputRef}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          disabled={!canSend || sending}
          placeholder={
            active
              ? 'aguarde a run terminar para continuar a conversa'
              : canSend
                ? 'continuar conversa (nova run com --resume no mesmo worktree)…'
                : 'run sem sessão do claude — não dá para continuar'
          }
          className="min-w-0 flex-1 rounded border border-edge2 bg-void px-2 py-1.5 text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-amber/60 disabled:opacity-50"
        />
        <Btn type="submit" tone="primary" disabled={!canSend || sending || !msg.trim()}>
          {sending ? '…' : 'enviar'}
        </Btn>
      </form>
    </div>
  )
}
