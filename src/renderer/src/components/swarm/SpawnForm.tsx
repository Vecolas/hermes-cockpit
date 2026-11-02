import { useEffect, useState, type ReactNode } from 'react'
import { invoke } from '../../lib/ipc'
import { SWARM_PERM_LABEL } from '../../lib/automode'
import { errMsg, newGroupId, refreshSwarm, repoName, swarmApi, type RunMeta, type SpawnInput } from '../../lib/swarm'
import { toast } from '../../lib/toast'
import { cx } from '../ui'
import { Btn } from './ui'

// "Delegar tarefa" → swarm:spawn. Três blocos na ordem em que a pessoa pensa
// (1 o quê · 2 onde · 3 como) e uma prévia honesta do que vai acontecer.
// Várias linhas com "uma run por linha" viram várias runs no mesmo groupId.
// Repos sugeridos de ops:repos (se existir).

interface RepoInfo {
  path: string
  name: string
  branch?: string
  dirty: number
}

type Perm = NonNullable<SpawnInput['permissionMode']>

const MODELS = ['sonnet', 'opus', 'haiku']
const CWD_KEY = 'hc.swarm.lastCwd'

const PERM_HINT: Record<Perm, string> = {
  manual: 'Bash, rede e MCP externos param e pedem sua aprovação aqui. Edições dentro do worktree passam direto.',
  auto: 'O classificador do Claude decide; só o arriscado vira card de aprovação.',
  acceptEdits: 'Edições liberadas; o resto pede aprovação.',
  bypass: 'Nada pede aprovação. Use só em repo descartável.',
}

function readLastCwd(): string {
  try {
    return localStorage.getItem(CWD_KEY) ?? ''
  } catch {
    return ''
  }
}

export function SpawnForm({ onDone, onCancel }: { onDone: (runs: RunMeta[]) => void; onCancel: () => void }) {
  const [task, setTask] = useState('')
  const [cwd, setCwd] = useState(readLastCwd)
  const [title, setTitle] = useState('')
  const [model, setModel] = useState('')
  const [perm, setPerm] = useState<Perm>('manual')
  useEffect(() => {
    swarmApi.config().then((c) => c?.defaultPermissionMode && setPerm(c.defaultPermissionMode), () => {})
  }, [])
  const [perLine, setPerLine] = useState(true)
  const [repos, setRepos] = useState<RepoInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancel = false
    invoke<RepoInfo[]>('ops:repos').then(
      (r) => !cancel && setRepos(Array.isArray(r) ? r : []),
      () => !cancel && setRepos([]),
    )
    return () => {
      cancel = true
    }
  }, [])

  const lines = task
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const multi = perLine && lines.length > 1
  const count = multi ? lines.length : lines.length ? 1 : 0
  const dir = cwd.trim()
  const ready = count > 0 && Boolean(dir)
  const known = repos?.find((r) => r.path === dir)

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    setErr(null)
    try {
      localStorage.setItem(CWD_KEY, dir)
    } catch {
      /* ignore */
    }
    const groupId = multi ? newGroupId() : undefined
    const tasks = multi ? lines : [task.trim()]
    const made: RunMeta[] = []
    const fails: string[] = []
    for (const [i, t] of tasks.entries()) {
      try {
        made.push(
          await swarmApi.spawn({
            task: t,
            cwd: dir,
            title: (multi ? (title.trim() ? `${title.trim()} #${i + 1}` : t.slice(0, 60)) : title.trim()) || undefined,
            model: model.trim() || undefined,
            groupId,
            permissionMode: perm,
          }),
        )
      } catch (e) {
        fails.push(errMsg(e))
      }
    }
    setBusy(false)
    void refreshSwarm()
    if (fails.length) {
      setErr(fails[0])
      toast({ title: `${fails.length} de ${tasks.length} falharam ao iniciar`, detail: fails[0], tone: 'error' })
    }
    if (made.length) {
      toast({ title: made.length > 1 ? `${made.length} runs delegadas` : 'Tarefa delegada', detail: 'acompanhe a etapa no detalhe', tone: 'ok' })
      onDone(made)
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void submit()
        }
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
      className="flex flex-col gap-4"
    >
      <Block n={1} title="O que fazer" done={count > 0}>
        <textarea
          autoFocus
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={5}
          placeholder={'Descreva a tarefa como faria para um colega.\nEx.: “adicione testes para lib/flow.ts cobrindo cada status”'}
          className="w-full resize-y rounded-md border border-edge2 bg-void px-2.5 py-2 text-[12px] leading-relaxed text-ink outline-none transition-[border-color,box-shadow] duration-[var(--hc-dur-2)] placeholder:text-faint focus:border-amber/60 focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-amber)_12%,transparent)]"
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[10.5px] text-dim">
            <input type="checkbox" checked={perLine} onChange={(e) => setPerLine(e.target.checked)} className="accent-amber" />
            uma run por linha
          </label>
          {multi && <span className="hc-pop text-[10.5px] text-amber">→ {lines.length} runs em paralelo, num grupo</span>}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="título curto (opcional)"
            className="ml-auto w-48 rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
          />
        </div>
      </Block>

      <Block n={2} title="Onde" done={Boolean(dir)}>
        <input
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          list="hc-swarm-repos"
          placeholder="repo / pasta (caminho absoluto)"
          className="w-full rounded-md border border-edge2 bg-void px-2.5 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
        />
        <datalist id="hc-swarm-repos">
          {(repos ?? []).map((r) => (
            <option key={r.path} value={r.path}>
              {r.name}
              {r.branch ? ` · ${r.branch}` : ''}
              {r.dirty ? ` · ${r.dirty} alterados` : ''}
            </option>
          ))}
        </datalist>
        {repos && repos.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {repos.slice(0, 10).map((r) => (
              <button
                key={r.path}
                type="button"
                onClick={() => setCwd(r.path)}
                title={r.path}
                className={cx(
                  'hc-press rounded-full border px-2 py-0.5 text-[10.5px]',
                  dir === r.path ? 'border-amber/70 bg-amber/10 text-amber' : 'border-edge text-faint hover:border-edge2 hover:text-dim',
                )}
              >
                {r.name}
                {r.dirty > 0 && <span className="ml-1 text-amber/70">●</span>}
              </button>
            ))}
          </div>
        )}
        {repos === null && <div className="mt-1.5 text-[10px] text-faint">carregando repos…</div>}
      </Block>

      <Block n={3} title="Como rodar" done>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="permissões">
            {(Object.keys(SWARM_PERM_LABEL) as Perm[]).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={perm === k}
                onClick={() => setPerm(k)}
                className={cx(
                  'hc-press rounded-md border px-2 py-1 text-[10.5px]',
                  perm === k
                    ? k === 'bypass'
                      ? 'border-alert/70 bg-alert/10 text-alert'
                      : 'border-amber/70 bg-amber/10 text-ink'
                    : 'border-edge2 text-faint hover:text-dim',
                )}
              >
                {SWARM_PERM_LABEL[k].split(' (')[0]}
              </button>
            ))}
          </div>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            list="hc-swarm-models"
            placeholder="modelo (padrão)"
            className="w-32 rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
          />
          <datalist id="hc-swarm-models">
            {MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>
        <p key={perm} className={cx('hc-fade-in mt-1.5 text-[10.5px]', perm === 'bypass' ? 'text-alert' : 'text-dim')}>
          {PERM_HINT[perm]}
        </p>
      </Block>

      {/* prévia do fluxo: o que acontece ao apertar o botão */}
      <div className="rounded-md border border-dashed border-edge2 bg-void/50 px-3 py-2 text-[10.5px] leading-relaxed text-dim">
        <span className="label mr-2">o que vai acontecer</span>
        {ready ? (
          <>
            {count > 1 ? `${count} runs` : '1 run'} em <span className="text-ink">{known?.name ?? repoName(dir)}</span>
            {' → '}worktree isolado <span className="font-mono text-faint">hermes/&lt;id&gt;</span>
            {' → '}Claude executa
            {perm !== 'bypass' && <> {' → '}<span className="text-amber">para e pergunta a você</span> quando precisar</>}
            {' → '}você revisa o diff. Nada é commitado.
          </>
        ) : (
          <span className="text-faint">preencha {[!count && 'a tarefa', !dir && 'onde rodar'].filter(Boolean).join(' e ')} para ver.</span>
        )}
      </div>

      {err && <div className="hc-rise rounded border border-alert/40 bg-alert/5 px-2.5 py-1.5 text-[11px] text-alert">{err}</div>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy || !ready}
          className="hc-press flex h-8 items-center gap-2 rounded-md border border-amber/70 bg-amber px-4 text-[12px] font-semibold text-void hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'delegando…' : count > 1 ? `Delegar ${count} runs` : 'Delegar'}
          <span className="rounded bg-void/15 px-1 font-mono text-[10px] font-normal">⌘↵</span>
        </button>
        <Btn tone="ghost" onClick={onCancel}>
          cancelar <span className="text-faint">esc</span>
        </Btn>
      </div>
    </form>
  )
}

function Block({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 flex items-center gap-2">
        <span
          className={cx(
            'flex h-4 w-4 items-center justify-center rounded-full border font-mono text-[9.5px] transition-colors duration-[var(--hc-dur-2)]',
            done ? 'border-amber/70 bg-amber text-void' : 'border-edge2 text-faint',
          )}
        >
          {done ? '✓' : n}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-dim">{title}</span>
      </legend>
      {children}
    </fieldset>
  )
}
