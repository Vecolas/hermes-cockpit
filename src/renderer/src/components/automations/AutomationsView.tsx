import { useCallback, useMemo, useState } from 'react'
import { type CronJob, cronApi, jobNextRuns, jobPaused, jobSpace, usePolled } from '../../lib/automations'
import { hasMain } from '../../lib/ipc'
import type { HermesRpc } from '../../lib/rpc'
import { SPACES, inSpace, useSpace } from '../../lib/space'
import { useViewActive } from '../layout/views'
import { Tabs, cx } from '../ui'
import { BlueprintsTab } from './BlueprintsTab'
import { CronsTab } from './CronsTab'
import { FlowsTab } from './FlowsTab'
import { KanbanTab } from './KanbanTab'
import { Countdown } from './ui'

// Automações: crons do Hermes por bot, galeria de blueprints, kanban dos bots
// e workflows do swarm salvos. Tudo filtrado pelo espaço ativo (lib/space).
// CONTRATO: nome do export e props são fixos.

type Tab = 'crons' | 'blueprints' | 'kanban' | 'workflows'
const TAB_KEY = 'hermes-cockpit.automations.tab'

function loadTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY)
    return v === 'blueprints' || v === 'kanban' || v === 'workflows' ? v : 'crons'
  } catch {
    return 'crons'
  }
}

export function AutomationsView(props: { rpc: HermesRpc | null }) {
  void props.rpc // crons/kanban são REST/IPC; o RPC não é necessário aqui
  const active = useViewActive()
  const space = useSpace()
  const [tab, setTabState] = useState<Tab>(loadTab)
  const [focusJob, setFocusJob] = useState<string | null>(null)
  const setTab = (t: Tab) => {
    setTabState(t)
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      /* sem storage */
    }
  }

  const [jobsState, reloadJobs] = usePolled(() => cronApi.list(), 30_000, active)
  const [targetsState] = usePolled(() => cronApi.targets(), 5 * 60_000, active)

  const jobs: CronJob[] | null = jobsState.phase === 'ready' ? jobsState.data : jobsState.phase === 'error' ? (jobsState.data ?? null) : null
  const targets = targetsState.phase === 'ready' ? targetsState.data.targets : null
  const inSp = useMemo(() => (jobs ?? []).filter((j) => inSpace(jobSpace(j), space)), [jobs, space])

  const nextUp = useMemo(() => {
    let best: { job: CronJob; at: Date } | null = null
    for (const j of inSp) {
      const at = jobNextRuns(j, 1)[0]
      if (at && (!best || at < best.at)) best = { job: j, at }
    }
    return best
  }, [inSp])

  const onFocused = useCallback(() => setFocusJob(null), [])
  const scheduled = inSp.filter((j) => !jobPaused(j)).length
  const errors = inSp.filter((j) => j.last_status === 'error' || j.state === 'error').length

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-void">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge bg-panel/60 px-4 py-2.5">
        <div className="min-w-0">
          <div className="label">Automações</div>
          <div className="mt-0.5 text-[11px] text-faint">{SPACES.find((s) => s.id === space)?.label} · crons, blueprints, kanban e workflows</div>
        </div>
        <Tabs
          ariaLabel="seções de automações"
          variant="pill"
          value={tab}
          onChange={setTab}
          items={[
            { id: 'crons', label: 'Crons', badge: jobs ? <span className="tabular-nums">{inSp.length}</span> : undefined },
            { id: 'blueprints', label: 'Blueprints' },
            { id: 'kanban', label: 'Kanban', disabled: !hasMain() },
            { id: 'workflows', label: 'Workflows', disabled: !hasMain() },
          ]}
        />
        <div className="ml-auto flex items-center gap-4 text-[11px]">
          <Metric label="ativos" value={jobs ? String(scheduled) : '—'} />
          <Metric label="com erro" value={jobs ? String(errors) : '—'} tone={errors ? 'text-alert' : undefined} />
          <div className="min-w-0 text-right">
            <div className="label">próximo disparo</div>
            {nextUp ? (
              <button type="button" className="flex max-w-[260px] items-baseline gap-1.5 text-left hover:underline" onClick={() => { setTab('crons'); setFocusJob(nextUp.job.id) }}>
                <span className="truncate text-dim">{nextUp.job.name || nextUp.job.id}</span>
                <Countdown at={nextUp.at} className="hc-count shrink-0" />
              </button>
            ) : (
              <span className="text-faint">{jobsState.phase === 'error' ? 'indisponível' : '—'}</span>
            )}
          </div>
        </div>
      </header>
      <main key={tab} className="hc-view-in relative min-h-0 flex-1">
        {tab === 'crons' && (
          <CronsTab
            state={{
              jobs,
              error: jobsState.phase === 'error' ? jobsState.error : null,
              loading: jobsState.phase === 'loading',
              reload: reloadJobs,
              targets,
            }}
            focusId={focusJob}
            onFocused={onFocused}
          />
        )}
        {tab === 'blueprints' && (
          <BlueprintsTab
            targets={targets}
            active={active}
            onCreated={(j) => {
              void reloadJobs()
              setTab('crons')
              setFocusJob(j.id)
            }}
          />
        )}
        {tab === 'kanban' && <KanbanTab active={active} />}
        {tab === 'workflows' && <FlowsTab active={active} />}
      </main>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="text-right">
      <div className="label">{label}</div>
      <div className={cx('hc-count text-[14px] tabular-nums', tone ?? 'text-ink')}>{value}</div>
    </div>
  )
}
