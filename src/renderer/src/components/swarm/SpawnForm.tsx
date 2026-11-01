import { useEffect, useState } from 'react'
import { invoke } from '../../lib/ipc'
import { errMsg, newGroupId, refreshSwarm, swarmApi, type RunMeta } from '../../lib/swarm'
import { toast } from '../../lib/toast'
import { Btn } from './ui'

// Form "Nova tarefa" → swarm:spawn. Várias linhas com "uma run por linha" ligado
// viram várias runs no mesmo groupId. Repos sugeridos de ops:repos (se existir).

interface RepoInfo {
  path: string
  name: string
  branch?: string
  dirty: number
}

const MODELS = ['sonnet', 'opus', 'haiku']
const CWD_KEY = 'hc.swarm.lastCwd'

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

  const submit = async () => {
    if (!count || !cwd.trim()) return
    setBusy(true)
    setErr(null)
    const dir = cwd.trim()
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
      toast({ title: made.length > 1 ? `${made.length} runs iniciadas` : 'Run iniciada', tone: 'ok' })
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
        if (e.key === 'Escape') onCancel()
      }}
      className="hc-rise space-y-2 rounded-lg border border-edge2 bg-panel2/70 p-3"
    >
      <div className="label">nova tarefa</div>
      <textarea
        autoFocus
        value={task}
        onChange={(e) => setTask(e.target.value)}
        rows={4}
        placeholder={'o que o claude deve fazer?\n(uma linha por run, se "uma run por linha" estiver ligado)'}
        className="w-full resize-y rounded border border-edge2 bg-void px-2 py-1.5 text-[11.5px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
      />
      <input
        value={cwd}
        onChange={(e) => setCwd(e.target.value)}
        list="hc-swarm-repos"
        placeholder="repo / cwd (caminho absoluto)"
        className="w-full rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
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
        <div className="flex flex-wrap gap-1">
          {repos.slice(0, 8).map((r) => (
            <button
              key={r.path}
              type="button"
              onClick={() => setCwd(r.path)}
              title={r.path}
              className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
                cwd === r.path ? 'border-amber/60 text-amber' : 'border-edge text-faint hover:text-dim'
              }`}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="título (opcional)"
          className="min-w-0 flex-1 rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
        />
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          list="hc-swarm-models"
          placeholder="modelo (padrão)"
          className="w-28 rounded border border-edge2 bg-void px-2 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-amber/60"
        />
        <datalist id="hc-swarm-models">
          {MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
      <label className="flex items-center gap-2 text-[10.5px] text-dim">
        <input type="checkbox" checked={perLine} onChange={(e) => setPerLine(e.target.checked)} className="accent-amber" />
        uma run por linha {multi && <span className="text-amber">· {lines.length} runs num grupo</span>}
      </label>
      {err && <div className="text-[11px] text-alert">{err}</div>}
      <div className="flex items-center gap-2">
        <Btn type="submit" tone="primary" disabled={busy || !count || !cwd.trim()}>
          {busy ? 'iniciando…' : count > 1 ? `Iniciar ${count} runs` : 'Iniciar'}
        </Btn>
        <Btn tone="ghost" onClick={onCancel}>
          cancelar
        </Btn>
        <span className="ml-auto text-[10px] text-faint">⌘↵</span>
      </div>
    </form>
  )
}
