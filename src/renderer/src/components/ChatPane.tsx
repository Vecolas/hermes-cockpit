import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { BOT_TITLES, type BotProfile } from '../lib/bots'
import { chatReducer, initialChat, type PendingApproval } from '../lib/chat-store'
import {
  commandDispatch,
  commandsCatalog,
  createSideChat,
  execSlash,
  flattenCatalog,
  getProfileModel,
  interruptTurn,
  listSessions,
  parseGatewayEvent,
  resolveBotChat,
  respondApproval,
  resumeSession,
  submitPrompt,
  type ApprovalChoice,
  type ApprovalRequest,
  type ProfileModel,
  type SessionLiveInfo,
  type SessionRow,
  type SlashCommand,
  type SlashExecResult,
} from '../lib/gateway'
import { RpcError, type ConnState, type HermesRpc } from '../lib/rpc'
import { ApprovalCard } from './chat/ApprovalCard'
import { Composer } from './chat/Composer'
import { ModelPicker } from './chat/ModelPicker'
import { SessionMenu, type SessionTarget } from './chat/SessionMenu'
import { Transcript } from './chat/Transcript'

interface Props {
  rpc: HermesRpc | null
  bot: BotProfile | null
  connState: ConnState
}

/** Sessão aberta no painel. `runtimeId` é o id que prompt/eventos usam; o id armazenado
 *  só vive em memória enquanto a sessão está aberta (identidade do Bot Chat = título). */
interface OpenSession {
  profile: string
  runtimeId: string
  storedId: string | null
}

type Load = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; message: string }

const VERBOSE_KEY = 'hermes-cockpit.chat.verbose'

function readVerbose(): boolean {
  try {
    return localStorage.getItem(VERBOSE_KEY) === '1'
  } catch {
    return false
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function titleFor(name: string): string {
  return BOT_TITLES[name] ?? (name ? name[0].toUpperCase() + name.slice(1) : name)
}

export function ChatPane({ rpc, bot, connState }: Props) {
  const profile = bot?.name ?? null
  const title = profile ? titleFor(profile) : '—'
  const online = Boolean(rpc) && connState === 'open'

  const [chat, dispatch] = useReducer(chatReducer, initialChat)
  const [target, setTarget] = useState<SessionTarget>({ kind: 'canonical' })
  const [session, setSession] = useState<OpenSession | null>(null)
  const [load, setLoad] = useState<Load>({ phase: 'idle' })
  const [reloadNonce, setReloadNonce] = useState(0)
  const [approvals, setApprovals] = useState<PendingApproval[]>([])
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [model, setModel] = useState<ProfileModel | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [sideChats, setSideChats] = useState<SessionRow[]>([])
  const [sideError, setSideError] = useState<string | null>(null)
  const [verbose, setVerbose] = useState(readVerbose)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null)

  const activeSid = useRef<string | null>(null)
  activeSid.current = session?.runtimeId ?? null
  const loadToken = useRef(0)
  /** side-chat recém-criado (lazy: ainda sem linha no DB, não dá para dar resume) */
  const freshSide = useRef<{ storedId: string; runtimeId: string; info: SessionLiveInfo } | null>(null)
  const resolvers = useRef(new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>())
  const approvalSeq = useRef(0)
  /** `${session_id}::${request_id}` → card vivo, para deduplicar re-entregas de open_requests */
  const liveByRequest = useRef(new Map<string, { key: string; promise: Promise<unknown> }>())

  // ── troca de bot: volta para o Bot Chat canônico ──────────────────────────
  useEffect(() => {
    setTarget({ kind: 'canonical' })
    setPickerOpen(false)
    setModel(null)
    setModelError(null)
    freshSide.current = null
  }, [profile])

  useEffect(() => {
    try {
      localStorage.setItem(VERBOSE_KEY, verbose ? '1' : '0')
    } catch {
      /* preferência local opcional */
    }
  }, [verbose])

  // ── aprovações ─────────────────────────────────────────────────────────────
  const addApproval = useCallback((a: PendingApproval) => {
    setApprovals((prev) => {
      const rid = a.request.request_id
      if (rid && prev.some((p) => p.request.request_id === rid && p.sessionId === a.sessionId)) return prev
      return [...prev, a]
    })
  }, [])

  const dropApproval = useCallback((key: string, reason?: string) => {
    const r = resolvers.current.get(key)
    if (r) {
      resolvers.current.delete(key)
      if (reason) r.reject(new Error(reason))
    }
    setApprovals((prev) => prev.filter((p) => p.key !== key))
  }, [])

  /** request.cancel não diz qual card morreu (o handler não recebe o id JSON-RPC):
   *  reconcilia com approval.pending da sessão. */
  const reconcileApprovals = useCallback(
    async (sessionId: string) => {
      if (!rpc) return
      let pending: ApprovalRequest[] = []
      try {
        const res = await rpc.call<{ approvals?: ApprovalRequest[] }>('approval.pending', { session_id: sessionId })
        pending = res?.approvals ?? []
      } catch (e) {
        // 4001 = sessão não está viva (fechada/reaped): nenhum card dela sobrevive.
        // Outras falhas (transporte): mantém os cards, sem certeza do estado.
        if (!(e instanceof RpcError && e.code === 4001)) return
        pending = []
      }
      const alive = new Set(pending.map((p) => p.request_id).filter(Boolean))
      setApprovals((prev) => {
        const keep: PendingApproval[] = []
        for (const a of prev) {
          if (a.sessionId === sessionId && !(a.request.request_id && alive.has(a.request.request_id))) {
            const r = resolvers.current.get(a.key)
            resolvers.current.delete(a.key)
            r?.reject(new Error('aprovação retirada pelo backend'))
          } else keep.push(a)
        }
        return keep
      })
    },
    [rpc],
  )

  // server requests: `approval` vira card; o resto é recusado com erro explícito
  useEffect(() => {
    if (!rpc) return
    const pending = resolvers.current
    rpc.setRequestHandler((method, params) => {
      if (method !== 'approval') {
        return Promise.reject(new Error(`cockpit: server request "${method}" ainda não suportado`))
      }
      const req = (params ?? {}) as ApprovalRequest
      const sessionId = String(req.session_id ?? '')
      // re-entrega de open_requests a cada session.resume: o card original já responde
      // ao mesmo id do servidor — reaproveita a Promise dele em vez de vazar um resolver novo
      const rid = req.request_id
      if (rid) {
        const dup = liveByRequest.current.get(`${sessionId}::${rid}`)
        if (dup && pending.has(dup.key)) return dup.promise
      }
      const key = `live-${++approvalSeq.current}`
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(key, { resolve, reject })
        addApproval({ key, rpcId: key, sessionId, request: req })
      })
      if (rid) {
        const mapKey = `${sessionId}::${rid}`
        liveByRequest.current.set(mapKey, { key, promise })
        const forget = () => {
          if (liveByRequest.current.get(mapKey)?.key === key) liveByRequest.current.delete(mapKey)
        }
        promise.then(forget, forget)
      }
      return promise
    })
    return () => {
      rpc.setRequestHandler(null)
      for (const r of pending.values()) r.reject(new Error('painel de chat desmontado'))
      pending.clear()
      liveByRequest.current.clear()
      setApprovals([])
    }
  }, [rpc, addApproval])

  const respond = useCallback(
    async (a: PendingApproval, choice: ApprovalChoice) => {
      const live = resolvers.current.get(a.key)
      if (a.rpcId && live) {
        resolvers.current.delete(a.key)
        live.resolve({ choice })
        setApprovals((prev) => prev.filter((p) => p.key !== a.key))
        return
      }
      if (!rpc) throw new Error('sem conexão com o backend')
      await respondApproval(rpc, a.sessionId, choice, a.request.request_id)
      dropApproval(a.key)
    },
    [rpc, dropApproval],
  )

  // ── side-chats ─────────────────────────────────────────────────────────────
  const refreshSides = useCallback(() => {
    if (!rpc || !profile || !online) return
    listSessions(rpc, profile)
      .then((rows) => {
        setSideChats(rows)
        setSideError(null)
      })
      .catch((e) => setSideError(errText(e)))
  }, [rpc, profile, online])

  useEffect(() => {
    setSideChats([])
    refreshSides()
  }, [refreshSides])

  // ── eventos do gateway (filtrados pela sessão ativa) ──────────────────────
  const sidesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!rpc) return
    const unsubscribe = rpc.subscribe((method, params) => {
      const ev = parseGatewayEvent(method, params)
      if (!ev) return
      if (ev.type === 'request.cancel') {
        if (ev.payload?.method === 'approval' && ev.session_id) void reconcileApprovals(ev.session_id)
        return
      }
      if (ev.type === 'sessions.changed') {
        if (sidesTimer.current) clearTimeout(sidesTimer.current)
        sidesTimer.current = setTimeout(refreshSides, 800)
        return
      }
      if (ev.session_id && ev.session_id === activeSid.current) dispatch({ type: 'event', event: ev })
    })
    return () => {
      unsubscribe()
      if (sidesTimer.current) clearTimeout(sidesTimer.current)
    }
  }, [rpc, reconcileApprovals, refreshSides])

  // ── abrir sessão (Bot Chat canônico ou side-chat) ─────────────────────────
  const targetKey = target.kind === 'canonical' ? 'canonical' : `side:${target.storedId}`
  useEffect(() => {
    // troca de bot com side-chat aberto: espera o reset para o Bot Chat do novo profile
    if (target.kind === 'side' && target.profile && target.profile !== profile) return
    const token = ++loadToken.current
    setSession(null)
    dispatch({ type: 'reset' })
    setCommands([])
    if (!rpc || !profile || !online) {
      setLoad({ phase: 'idle' })
      return
    }
    setLoad({ phase: 'loading' })
    const stale = () => token !== loadToken.current

    ;(async () => {
      // modelo + "Bot Chat existe?" vêm do profiles.list; falha aqui = falha fechada
      let pm: ProfileModel | null = null
      try {
        pm = await getProfileModel(rpc, profile)
        if (!stale()) {
          setModel(pm)
          setModelError(null)
        }
      } catch (e) {
        if (!stale()) setModelError(errText(e))
      }

      let open: OpenSession
      let resumed: Awaited<ReturnType<typeof resumeSession>> | null = null
      const fresh = freshSide.current
      const useFresh = target.kind === 'side' && fresh !== null && fresh.storedId === target.storedId
      // atalho só na PRIMEIRA abertura: reabrir (ou reconectar) passa por session.resume,
      // que acha a sessão viva não-persistida e religa o transporte ao socket atual
      freshSide.current = null
      if (useFresh && fresh) {
        open = { profile, runtimeId: fresh.runtimeId, storedId: fresh.storedId }
      } else {
        let storedId: string
        if (target.kind === 'canonical') {
          if (!pm) throw new Error('não foi possível ler o profile — Bot Chat não resolvido (nada foi criado)')
          const row = await resolveBotChat(rpc, profile, { hadCanonical: pm.hasCanonical })
          storedId = row.resolved_id || row.id
        } else {
          storedId = target.storedId
        }
        if (stale()) return
        resumed = await resumeSession(rpc, storedId, profile)
        open = { profile, runtimeId: resumed.session_id, storedId: resumed.stored_session_id ?? storedId }
      }
      if (stale()) return

      setSession(open)
      activeSid.current = open.runtimeId
      if (resumed) {
        dispatch({
          type: 'load',
          messages: resumed.messages ?? [],
          info: resumed.info ?? null,
          running: Boolean(resumed.running),
          inflight: resumed.inflight ?? null,
        })
        // aprovações que já estavam pendentes (reconexão / turno em andamento)
        if (resumed.pending_approval?.request_id) {
          addApproval({
            key: `restored-${resumed.pending_approval.request_id}`,
            rpcId: null,
            sessionId: open.runtimeId,
            request: resumed.pending_approval,
          })
        }
        // `open_requests` não é tratado aqui: o HermesRpc re-entrega cada um ao
        // setRequestHandler antes de resolver o session.resume (vira card "vivo").
      } else if (useFresh && fresh) {
        dispatch({ type: 'load', messages: [], info: fresh.info, running: false, inflight: null })
      }
      setLoad({ phase: 'ready' })

      try {
        const cat = await commandsCatalog(rpc, { profile, sessionId: open.runtimeId })
        if (!stale()) setCommands(flattenCatalog(cat))
      } catch {
        /* autocomplete degradado: sem catálogo, slash ainda é enviado ao backend */
      }
    })().catch((e) => {
      if (!stale()) setLoad({ phase: 'error', message: errText(e) })
    })
    // target é coberto por targetKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, profile, online, targetKey, reloadNonce, addApproval])

  // ── ações ──────────────────────────────────────────────────────────────────
  const sid = session?.runtimeId ?? null

  const sendPrompt = useCallback(
    async (text: string, display?: string): Promise<boolean> => {
      if (!rpc || !sid) return false
      dispatch({ type: 'user', text: display ?? text })
      dispatch({ type: 'running', running: true })
      try {
        const res = await submitPrompt(rpc, sid, text)
        if (res?.status === 'queued') dispatch({ type: 'note', tone: 'info', text: 'na fila — entra quando o turno atual terminar' })
        else if (res?.status === 'steered') dispatch({ type: 'note', tone: 'info', text: 'enviado como ajuste ao turno em andamento' })
        else if (res?.status === 'redirected') dispatch({ type: 'note', tone: 'info', text: 'turno redirecionado' })
        return true
      } catch (e) {
        dispatch({ type: 'running', running: false })
        dispatch({ type: 'note', tone: 'error', text: `falha ao enviar: ${errText(e)}` })
        return false
      }
    },
    [rpc, sid],
  )

  const handleDispatch = useCallback(
    async (cmd: string, d: SlashExecResult, depth: number): Promise<boolean> => {
      switch (d.type) {
        case 'send':
          if (d.notice) dispatch({ type: 'note', tone: 'info', text: d.notice })
          return d.message ? sendPrompt(d.message, d.display || d.message) : true
        case 'skill':
          return d.message ? sendPrompt(d.message, d.display || cmd) : true
        case 'prefill':
          if (d.notice) dispatch({ type: 'note', tone: 'info', text: d.notice })
          setPrefill({ text: d.message ?? '', nonce: Date.now() })
          return true
        case 'alias':
          if (d.target && depth < 3) return runSlashRef.current(`/${d.target.replace(/^\/+/, '')}`, depth + 1)
          return true
        default:
          dispatch({ type: 'slash', command: cmd, output: d.output ?? '', warning: d.warning ?? '' })
          return true
      }
    },
    [sendPrompt],
  )

  const runSlash = useCallback(
    async (text: string, depth = 0): Promise<boolean> => {
      if (!rpc || !sid) return false
      const [head, ...rest] = text.trim().split(/\s+/)
      const name = head.replace(/^\/+/, '')
      const arg = rest.join(' ')
      try {
        const res = await execSlash(rpc, sid, text.trim())
        if (res?.type) return handleDispatch(text.trim(), res, depth)
        dispatch({ type: 'slash', command: text.trim(), output: res?.output ?? '', warning: res?.warning ?? '' })
        return true
      } catch (execErr) {
        try {
          const d = await commandDispatch(rpc, sid, name, arg)
          return handleDispatch(text.trim(), d, depth)
        } catch {
          dispatch({ type: 'note', tone: 'error', text: `${head}: ${errText(execErr)}` })
          return false
        }
      }
    },
    [rpc, sid, handleDispatch],
  )
  const runSlashRef = useRef(runSlash)
  runSlashRef.current = runSlash

  const onSend = useCallback(
    (text: string) => (text.startsWith('/') ? runSlash(text) : sendPrompt(text)),
    [runSlash, sendPrompt],
  )

  const onCancel = useCallback(() => {
    if (!rpc || !sid) return
    interruptTurn(rpc, sid).catch((e) => dispatch({ type: 'note', tone: 'error', text: `cancelar falhou: ${errText(e)}` }))
  }, [rpc, sid])

  const onNewSide = useCallback(async () => {
    if (!rpc || !profile) return
    try {
      const created = await createSideChat(rpc, profile)
      freshSide.current = { storedId: created.stored_session_id, runtimeId: created.session_id, info: created.info }
      setTarget({ kind: 'side', storedId: created.stored_session_id, title: 'novo side-chat', profile })
    } catch (e) {
      dispatch({ type: 'note', tone: 'error', text: `não foi possível criar side-chat: ${errText(e)}` })
    }
  }, [rpc, profile])

  // ── derivados de exibição ─────────────────────────────────────────────────
  const quick = useMemo(
    () =>
      commands
        .filter((c) => c.kind === 'skill' && c.usage > 0)
        .sort((a, b) => b.usage - a.usage)
        .slice(0, 3),
    [commands],
  )

  const modelName = model?.model ?? bot?.modelo ?? null
  const fallbackName = model?.fallback[0]?.model ?? null
  const approvalMode = typeof chat.info?.approval_mode === 'string' ? chat.info.approval_mode : null
  const usage = chat.usage
  const ctxPct = typeof usage?.context_percent === 'number' ? usage.context_percent : null
  const totalTok = typeof usage?.total === 'number' ? usage.total : null

  const visibleApprovals = approvals
  const composerDisabled = !online || load.phase !== 'ready' || !sid
  const disabledReason = !rpc || connState !== 'open'
    ? 'backend desconectado'
    : !profile
      ? 'selecione um bot'
      : load.phase === 'loading'
        ? 'abrindo sessão…'
        : load.phase === 'error'
          ? 'sessão indisponível'
          : undefined

  return (
    <section className="relative flex h-full min-h-0 w-full flex-col bg-void scanlines">
      {/* header */}
      <div className="relative z-20 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-edge px-5 py-2.5">
        <span className="font-display min-w-0 truncate text-base text-ink">{title}</span>
        <div className="relative min-w-0 max-w-[320px] shrink">
          <button
            disabled={!profile || !online}
            onClick={() => setPickerOpen((v) => !v)}
            title={modelError ?? 'trocar modelo'}
            className="block max-w-full truncate rounded border border-edge px-2 py-0.5 text-[11px] text-dim hover:border-amber/50 hover:text-ink disabled:opacity-50"
          >
            modelo: {modelName ?? (modelError ? 'erro' : '—')}
            {fallbackName && <span className="text-faint"> · fallback {fallbackName}</span>}
          </button>
          {pickerOpen && rpc && profile && (
            <ModelPicker
              rpc={rpc}
              profile={profile}
              sessionId={sid}
              currentModel={modelName}
              currentProvider={model?.provider ?? null}
              onClose={() => setPickerOpen(false)}
              onSwitched={(note) => {
                dispatch({ type: 'note', tone: 'info', text: note })
                if (rpc && profile) getProfileModel(rpc, profile).then(setModel).catch(() => {})
              }}
            />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-dim">
            <input type="checkbox" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} className="accent-amber" />
            verbose
          </label>
          <SessionMenu
            active={target}
            sideChats={sideChats}
            sideError={sideError}
            disabled={!profile || !online}
            onPick={(t) => setTarget(t.kind === 'side' ? { ...t, profile: profile ?? undefined } : t)}
            onNew={() => void onNewSide()}
            onRefresh={refreshSides}
          />
          <ConnBadge state={connState} />
        </div>
      </div>

      {/* corpo */}
      {!rpc || connState !== 'open' ? (
        <Centered>
          <div className="label mb-2 text-amber">backend {connState === 'connecting' ? 'conectando' : 'desconectado'}</div>
          <p className="max-w-sm text-dim">
            {connState === 'connecting'
              ? 'Abrindo o WebSocket do hermes serve…'
              : 'Sem conexão com o hermes serve. O chat volta sozinho quando a conexão reabrir.'}
          </p>
        </Centered>
      ) : !profile ? (
        <Centered>
          <p className="text-dim">Selecione um bot na rail para abrir o Bot Chat dele.</p>
        </Centered>
      ) : load.phase === 'error' ? (
        <Centered>
          <div className="max-w-md rounded-lg border border-alert/40 bg-panel p-4 text-left">
            <div className="label mb-1 text-alert">Falha ao abrir o chat</div>
            <pre className="whitespace-pre-wrap text-[12px] text-dim">{load.message}</pre>
            <button
              onClick={() => setReloadNonce((n) => n + 1)}
              className="mt-3 rounded border border-edge2 px-3 py-1 text-[12px] text-ink hover:border-amber/60"
            >
              tentar de novo
            </button>
          </div>
        </Centered>
      ) : (
        <Transcript
          items={chat.items}
          verbose={verbose}
          running={chat.running}
          status={chat.status}
          empty={
            load.phase === 'loading' ? (
              <div className="py-10 text-center text-dim">
                abrindo {target.kind === 'canonical' ? 'Bot Chat' : 'side-chat'} de {title}…
              </div>
            ) : (
              <div className="py-10 text-center text-faint">
                {target.kind === 'canonical' ? 'Bot Chat vazio' : 'side-chat novo'} — mande a primeira mensagem.
              </div>
            )
          }
          footer={
            visibleApprovals.length > 0 ? (
              <div className="flex flex-col gap-2">
                {visibleApprovals.map((a) => (
                  <div key={a.key}>
                    {a.sessionId !== sid && (
                      <div className="label mb-1 text-amber">outra sessão · {a.sessionId || '?'}</div>
                    )}
                    <ApprovalCard approval={a} onRespond={respond} />
                  </div>
                ))}
              </div>
            ) : undefined
          }
        />
      )}

      <Composer
        title={title}
        disabled={composerDisabled}
        disabledReason={disabledReason}
        running={chat.running}
        commands={commands}
        quick={quick}
        prefill={prefill}
        onSend={onSend}
        onCancel={onCancel}
        footerRight={[approvalMode ? `aprovação: ${approvalMode}` : null, modelName].filter(Boolean).join(' · ') || undefined}
        footerLeft={
          [
            target.kind === 'canonical' ? 'Bot Chat' : 'side-chat',
            ctxPct !== null ? `contexto ${ctxPct}%` : null,
            totalTok !== null ? `${totalTok.toLocaleString('pt-BR')} tokens` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
      />
    </section>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">{children}</div>
}

function ConnBadge({ state }: { state: ConnState }) {
  const map: Record<ConnState, { label: string; cls: string }> = {
    idle: { label: 'ocioso', cls: 'text-faint' },
    connecting: { label: 'conectando', cls: 'text-amber' },
    open: { label: 'ws aberto', cls: 'text-phos glow-phos' },
    closed: { label: 'fechado', cls: 'text-faint' },
    error: { label: 'erro', cls: 'text-alert' },
  }
  const { label, cls } = map[state]
  return (
    <span className={`flex items-center gap-2 text-[11px] ${cls}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}
