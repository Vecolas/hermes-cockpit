// Fluxo de delegação — UM vocabulário para runs do Claude Code em toda a UI:
//
//   criada → na fila → executando → aguardando você → concluída | falhou | cancelada
//
// `runFlow` diz em que etapa a run está; `nextStep` diz o que a pessoa deve
// fazer agora (ou que não precisa fazer nada). Tudo derivado do RunMeta real +
// aprovações pendentes; nenhuma etapa inventada.

import { errMsg, refreshSwarm, swarmApi, type Approval, type RunMeta } from './swarm'
import { toast } from './toast'

export type FlowStep = 'created' | 'queued' | 'running' | 'waiting' | 'end'
export type FlowOutcome = 'done' | 'error' | 'cancelled'

export const FLOW_STEPS: { id: FlowStep; label: string; hint: string }[] = [
  { id: 'created', label: 'Criada', hint: 'tarefa registrada; worktree isolado preparado' },
  { id: 'queued', label: 'Na fila', hint: 'runner subindo o claude' },
  { id: 'running', label: 'Executando', hint: 'claude trabalhando no worktree' },
  { id: 'waiting', label: 'Aguardando você', hint: 'pediu aprovação ou fez uma pergunta — só acontece se precisar' },
  { id: 'end', label: 'Resultado', hint: 'concluída, falhou ou cancelada' },
]

export const OUTCOME_LABEL: Record<FlowOutcome, string> = { done: 'Concluída', error: 'Falhou', cancelled: 'Cancelada' }

export interface FlowState {
  step: FlowStep
  index: number
  outcome?: FlowOutcome
  /** passou por "aguardando você" nesta run (só sabemos enquanto está lá) */
  waitingKind?: 'approval' | 'question'
}

export function runFlow(run: RunMeta, pending: Approval[]): FlowState {
  const mine = pending.filter((a) => a.runId === run.id)
  const asks = mine.some((a) => a.toolName === 'AskUserQuestion' || a.kind === 'question')
  const idx = (s: FlowStep) => FLOW_STEPS.findIndex((x) => x.id === s)
  switch (run.status) {
    case 'queued':
      return { step: 'queued', index: idx('queued') }
    case 'running':
      // aprovação pode chegar antes do runner virar o status (poll de 500ms)
      return mine.length
        ? { step: 'waiting', index: idx('waiting'), waitingKind: asks ? 'question' : 'approval' }
        : { step: 'running', index: idx('running') }
    case 'waiting_approval':
      return { step: 'waiting', index: idx('waiting'), waitingKind: asks ? 'question' : 'approval' }
    default:
      return { step: 'end', index: idx('end'), outcome: run.status }
  }
}

export type NextCta = 'approve' | 'answer' | 'review' | 'continue' | 'retry' | 'none'
export type NextTone = 'you' | 'wait' | 'ok' | 'bad' | 'idle'

export interface NextStep {
  tone: NextTone
  headline: string
  detail: string
  cta: NextCta
  ctaLabel?: string
}

/** O que a pessoa precisa fazer agora com esta run. */
export function nextStep(run: RunMeta, pending: Approval[]): NextStep {
  const f = runFlow(run, pending)
  const mine = pending.filter((a) => a.runId === run.id)
  if (f.step === 'waiting') {
    return f.waitingKind === 'question'
      ? {
          tone: 'you',
          headline: 'O Claude fez uma pergunta',
          detail: 'A run está parada esperando sua resposta. Responda abaixo para ela seguir.',
          cta: 'answer',
          ctaLabel: 'Responder',
        }
      : {
          tone: 'you',
          headline: mine.length > 1 ? `${mine.length} aprovações esperando você` : 'Uma aprovação espera você',
          detail: `A run está parada até você decidir${mine[0] ? ` sobre ${mine[0].toolName}` : ''}. Aprovar libera; negar devolve o motivo ao Claude.`,
          cta: 'approve',
          ctaLabel: 'Revisar aprovação',
        }
  }
  if (f.step === 'queued')
    return { tone: 'wait', headline: 'Na fila', detail: 'O runner está subindo o Claude no worktree. Nada a fazer.', cta: 'none' }
  if (f.step === 'running')
    return {
      tone: 'wait',
      headline: 'Executando',
      detail: 'Acompanhe o stream. Se o Claude precisar de algo fora do worktree, um card de aprovação aparece aqui.',
      cta: 'none',
    }
  if (run.status === 'done') {
    const isolated = run.cwd !== run.repo
    return {
      tone: 'ok',
      headline: 'Concluída — revise o resultado',
      detail: isolated
        ? 'As mudanças ficaram no worktree (nada foi commitado). Veja o diff; para ajustar, continue a conversa.'
        : 'Veja o resultado no stream; para ajustar, continue a conversa.',
      cta: isolated ? 'review' : run.claudeSessionId ? 'continue' : 'none',
      ctaLabel: isolated ? 'Ver diff' : 'Continuar conversa',
    }
  }
  if (run.status === 'error')
    return {
      tone: 'bad',
      headline: 'Falhou',
      detail: run.error ? `Motivo: ${run.error}` : 'Veja o fim do stream para o motivo.',
      cta: 'retry',
      ctaLabel: 'Repetir tarefa',
    }
  return {
    tone: 'idle',
    headline: 'Cancelada',
    detail: 'Interrompida antes de terminar. Dá para repetir a mesma tarefa num worktree novo.',
    cta: 'retry',
    ctaLabel: 'Repetir tarefa',
  }
}

/** Nova run com a mesma tarefa/repo/modelo (worktree novo). Devolve a run criada. */
export async function retryRun(run: RunMeta): Promise<RunMeta | null> {
  try {
    const next = await swarmApi.spawn({
      task: run.task,
      cwd: run.repo,
      title: run.title || undefined,
      model: run.model || undefined,
      permissionMode: run.permissionMode,
    })
    toast({ title: 'Tarefa repetida', detail: run.title || run.task.slice(0, 80), tone: 'ok' })
    void refreshSwarm()
    return next
  } catch (e) {
    toast({ title: 'Não foi possível repetir', detail: errMsg(e), tone: 'error' })
    return null
  }
}

/** "há 3 min" / "há 2 h" / "ontem" — relativo e curto */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'agora'
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.round(h / 24)
  return d === 1 ? 'ontem' : `há ${d} d`
}
