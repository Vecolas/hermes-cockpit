import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { BotsRail } from './components/BotsRail'
import { ChatPane } from './components/ChatPane'
import { DockPane } from './components/DockPane'
import { ErrorBoundary } from './components/ErrorBoundary'
import { StatusStrip } from './components/StatusStrip'
import { TopBar } from './components/TopBar'
import { CommandPalette, type PaletteItem } from './components/layout/CommandPalette'
import { ResizeHandle, useCollapseSync } from './components/layout/ResizeHandle'
import { SettingsPanel } from './components/layout/SettingsPanel'
import { SourceProvider, usePluginSource } from './components/panels/source'
import { API } from './components/panels/types'
import { botTitle, mergePluginBots, parseProfiles, type BotProfile } from './lib/bots'
import { connectBackend, saveManual, type Connection } from './lib/connection'
import {
  GROUP_IDS,
  NARROW_PX,
  SIZES,
  clearPaneSizes,
  loadPrefs,
  safeStorage,
  savePrefs,
  type UiPrefs,
} from './lib/layout'
import { loadRegions, resetRegions, saveRegions, type RegionLayout } from './lib/panels'
import { HermesRpc, type ConnState } from './lib/rpc'
import {
  PRESETS,
  SCALE_STEP,
  applyTheme,
  clampScale,
  loadTheme,
  saveTheme,
  type ThemePreset,
  type ThemeSettings,
} from './lib/theme'

export function App() {
  const [conn, setConn] = useState<Connection | null>(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [needsManual, setNeedsManual] = useState(false)
  const [connState, setConnState] = useState<ConnState>('idle')
  const [rpc, setRpc] = useState<HermesRpc | null>(null)

  // Tema aplicado antes de qualquer tela (inclusive erro/conexão manual).
  const [theme, setThemeState] = useState<ThemeSettings>(loadTheme)
  useEffect(() => {
    applyTheme(theme)
    saveTheme(theme)
  }, [theme])

  useEffect(() => {
    let alive = true
    let client: HermesRpc | null = null
    connectBackend()
      .then((c) => {
        if (!alive) return
        setConn(c)
        client = new HermesRpc()
        client.onState = (s) => alive && setConnState(s)
        client.connect(c.info.wsUrl)
        setRpc(client)
      })
      .catch((e: Error) => {
        if (!alive) return
        if (e.message === 'no-manual-connection') setNeedsManual(true)
        else setFatal(e.message)
      })
    return () => {
      alive = false
      client?.close()
    }
  }, [])

  if (needsManual) return <ManualConnect onDone={() => location.reload()} />

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center bg-void p-8">
        <div className="max-w-lg rounded-lg border border-alert/40 bg-panel p-6">
          <div className="label mb-2 text-alert">Falha ao subir o backend</div>
          <pre className="whitespace-pre-wrap text-[12px] text-dim">{fatal}</pre>
          <p className="mt-3 text-[11px] text-faint">
            Verifique se o CLI está no PATH (<code>which hermes</code>) e tente{' '}
            <code>hermes serve</code> manualmente.
          </p>
        </div>
      </div>
    )
  }

  return (
    <SourceProvider conn={conn}>
      <Cockpit conn={conn} rpc={rpc} connState={connState} theme={theme} setTheme={setThemeState} />
    </SourceProvider>
  )
}

interface CockpitProps {
  conn: Connection | null
  rpc: HermesRpc | null
  connState: ConnState
  theme: ThemeSettings
  setTheme: (t: ThemeSettings | ((t: ThemeSettings) => ThemeSettings)) => void
}

function Cockpit({ conn, rpc, connState, theme, setTheme }: CockpitProps) {
  // ─── bots: profiles.list (RPC) + /bots (plugin) ────────────────────────────
  const [rpcBots, setRpcBots] = useState<BotProfile[]>([])
  const [botsErr, setBotsErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>('chief')
  const pluginBots = usePluginSource<unknown>(API.bots, 300_000)

  useEffect(() => {
    if (!rpc || connState !== 'open') return
    let alive = true
    rpc
      .call('profiles.list')
      .then((res) => {
        if (!alive) return
        setRpcBots(parseProfiles(res))
        setBotsErr(null)
      })
      .catch((e: unknown) => alive && setBotsErr(`profiles.list: ${e instanceof Error ? e.message : String(e)}`))
    return () => {
      alive = false
    }
  }, [rpc, connState])

  const bots = useMemo(() => mergePluginBots(rpcBots, pluginBots.data), [rpcBots, pluginBots.data])
  const bot = bots.find((b) => b.name === selected) ?? null
  const botsLoading = !conn || (connState === 'connecting' && bots.length === 0)
  const railError = botsErr ?? (pluginBots.error ? `/bots: ${pluginBots.error}` : null)

  // ─── layout: prefs, regiões, breakpoint ───────────────────────────────────
  const [prefs, setPrefsState] = useState<UiPrefs>(loadPrefs)
  const setPrefs = useCallback((patch: Partial<UiPrefs> | ((p: UiPrefs) => Partial<UiPrefs>)) => {
    setPrefsState((p) => {
      const next = { ...p, ...(typeof patch === 'function' ? patch(p) : patch) }
      savePrefs(next)
      return next
    })
  }, [])
  const [regions, setRegionsState] = useState<RegionLayout>(loadRegions)
  const setRegions = (r: RegionLayout) => {
    setRegionsState(r)
    saveRegions(r)
  }

  const narrow = useNarrow(theme.scale)
  const [railOverlay, setRailOverlay] = useState(false)
  const [dockOverlay, setDockOverlay] = useState(false)
  useEffect(() => {
    if (!narrow) {
      setRailOverlay(false)
      setDockOverlay(false)
    }
  }, [narrow])

  const [palette, setPalette] = useState(false)
  const [settings, setSettings] = useState<null | 'aparencia' | 'paineis'>(null)

  const focus = prefs.focus
  const railVisible = prefs.railOpen && !focus && !narrow
  const dockVisible = prefs.dockOpen && !focus && !narrow
  const stripVisible = prefs.stripOpen && !focus

  const railRef = usePanelRef()
  const dockRef = usePanelRef()
  const stripRef = usePanelRef()
  // Último tamanho aberto (px CSS — a lib mede com offsetWidth, já sem o zoom) para restaurar após foco/janela estreita.
  const railPx = useRef<number | null>(null)
  const dockPx = useRef<number | null>(null)
  const stripPx = useRef<number | null>(null)
  const remember = (r: { current: number | null }) => (size: { inPixels: number }) => {
    if (size.inPixels > 1 && freeRef.current) r.current = Math.round(size.inPixels)
  }
  useCollapseSync(railRef, railVisible, railPx)
  useCollapseSync(dockRef, dockVisible, dockPx)
  useCollapseSync(stripRef, stripVisible, stripPx)

  const hLayout = useDefaultLayout({ id: GROUP_IDS.horizontal, storage: safeStorage, onlySaveAfterUserInteractions: true })
  const vLayout = useDefaultLayout({ id: GROUP_IDS.vertical, storage: safeStorage, onlySaveAfterUserInteractions: true })

  // Arrastar uma alça até colapsar = mudar a preferência (só interação do usuário).
  const freeLayout = !focus && !narrow
  const freeRef = useRef(freeLayout)
  freeRef.current = freeLayout

  const toggleRail = () => (narrow ? setRailOverlay((v) => !v) : setPrefs((p) => ({ railOpen: !p.railOpen, focus: false })))
  const toggleDock = () => (narrow ? setDockOverlay((v) => !v) : setPrefs((p) => ({ dockOpen: !p.dockOpen, focus: false })))
  const toggleStrip = () => setPrefs((p) => ({ stripOpen: !p.stripOpen, focus: false }))
  const toggleFocus = () => setPrefs((p) => ({ focus: !p.focus }))
  const bumpScale = (d: number) => setTheme((t) => ({ ...t, scale: clampScale(d === 0 ? 100 : t.scale + d) }))

  const resetSizes = () => {
    clearPaneSizes()
    setPrefs({ railOpen: true, dockOpen: true, stripOpen: true, dockCardsOpen: true, focus: false })
    requestAnimationFrame(() => {
      try {
        railRef.current?.resize(SIZES.rail.default)
        dockRef.current?.resize(SIZES.dock.default)
        stripRef.current?.resize(SIZES.strip.default)
      } catch {
        /* painel colapsado ainda expandindo */
      }
    })
  }

  // ─── atalhos ──────────────────────────────────────────────────────────────
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    const k = e.key.toLowerCase()
    const act = (fn: () => void) => {
      e.preventDefault()
      fn()
    }
    if (k === 'k') act(() => setPalette((v) => !v))
    else if (k === '.') act(toggleFocus)
    else if (k === '=' || k === '+') act(() => bumpScale(SCALE_STEP))
    else if (k === '-' || k === '_') act(() => bumpScale(-SCALE_STEP))
    else if (k === '0') act(() => bumpScale(0))
    else if (k === 'b' && !e.shiftKey) act(toggleRail)
    else if (k === 'j' && !e.shiftKey) act(toggleDock)
    else if (k === ',') act(() => setSettings('aparencia'))
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])

  // ─── command palette ──────────────────────────────────────────────────────
  const paletteItems: PaletteItem[] = [
    ...bots.map((b) => ({
      id: `bot:${b.name}`,
      group: 'bot',
      label: `Abrir chat: ${botTitle(b.name)}`,
      hint: [b.name, b.modelo].filter(Boolean).join(' · '),
      run: () => {
        setSelected(b.name)
        setRailOverlay(false)
      },
    })),
    { id: 'focus', group: 'layout', label: focus ? 'Sair do modo foco' : 'Modo foco', hint: '⌘.', run: toggleFocus },
    { id: 'rail', group: 'layout', label: 'Alternar rail de bots', hint: '⌘B', run: toggleRail },
    { id: 'dock', group: 'layout', label: 'Alternar dock', hint: '⌘J', run: toggleDock },
    { id: 'strip', group: 'layout', label: 'Alternar strip inferior', run: toggleStrip },
    {
      id: 'cards',
      group: 'layout',
      label: 'Alternar cards do dock',
      run: () => setPrefs((p) => ({ dockCardsOpen: !p.dockCardsOpen })),
    },
    { id: 'panels', group: 'layout', label: 'Configurar painéis…', run: () => setSettings('paineis') },
    { id: 'reset-sizes', group: 'layout', label: 'Restaurar tamanhos dos painéis', run: resetSizes },
    ...(Object.keys(PRESETS) as ThemePreset[]).map((id) => ({
      id: `theme:${id}`,
      group: 'tema',
      label: `Tema ${PRESETS[id].label}`,
      run: () => setTheme((t) => ({ ...t, preset: id })),
    })),
    { id: 'zoom-in', group: 'tema', label: 'Aumentar escala', hint: '⌘=', run: () => bumpScale(SCALE_STEP) },
    { id: 'zoom-out', group: 'tema', label: 'Diminuir escala', hint: '⌘-', run: () => bumpScale(-SCALE_STEP) },
    { id: 'zoom-reset', group: 'tema', label: 'Escala 100%', hint: '⌘0', run: () => bumpScale(0) },
    { id: 'settings', group: 'app', label: 'Configurações…', hint: '⌘,', run: () => setSettings('aparencia') },
  ]

  const rail = (
    <ErrorBoundary label="Bots">
    <BotsRail
      bots={bots}
      selected={selected}
      onSelect={(n) => {
        setSelected(n)
        setRailOverlay(false)
      }}
      loading={botsLoading}
      error={railError}
    />
    </ErrorBoundary>
  )
  const dock = (
    <ErrorBoundary label="Dock">
    <DockPane
      tab={prefs.dockTab}
      onTabChange={(id) => setPrefs({ dockTab: id })}
      cards={regions.dock}
      cardsOpen={prefs.dockCardsOpen}
      onCardsOpenChange={(open) => setPrefs({ dockCardsOpen: open })}
    />
    </ErrorBoundary>
  )

  return (
    <div className="flex h-full flex-col bg-void" data-narrow={narrow || undefined} data-focus={focus || undefined}>
      <ErrorBoundary
        label="Topbar"
        compact
        className={`app-drag h-11 shrink-0 border-b border-edge bg-panel ${window.hermes ? 'pl-[84px]' : ''}`}
      >
      <TopBar
        connState={connState}
        electron={Boolean(window.hermes)}
        narrow={narrow}
        railOpen={narrow ? railOverlay : prefs.railOpen}
        dockOpen={narrow ? dockOverlay : prefs.dockOpen}
        focus={focus}
        onOpenPalette={() => setPalette(true)}
        onToggleRail={toggleRail}
        onToggleDock={toggleDock}
        onToggleFocus={toggleFocus}
        onOpenSettings={() => setSettings('aparencia')}
      />
      </ErrorBoundary>

      <div className="relative min-h-0 flex-1">
        <Group
          id={GROUP_IDS.vertical}
          orientation="vertical"
          className="h-full"
          defaultLayout={vLayout.defaultLayout}
          onLayoutChanged={(l, meta) => {
            vLayout.onLayoutChanged(l, meta)
            if (meta.isUserInteraction && !focus && l.strip !== undefined) {
              const open = l.strip > 0.5
              if (open !== prefs.stripOpen) setPrefs({ stripOpen: open })
            }
          }}
        >
          <Panel id="body" minSize={SIZES.bodyMin}>
            <Group
              id={GROUP_IDS.horizontal}
              orientation="horizontal"
              className="h-full"
              defaultLayout={hLayout.defaultLayout}
              onLayoutChanged={(l, meta) => {
                hLayout.onLayoutChanged(l, meta)
                if (!meta.isUserInteraction || !freeRef.current) return
                const patch: Partial<UiPrefs> = {}
                if (l.rail !== undefined && l.rail > 0.5 !== prefs.railOpen) patch.railOpen = l.rail > 0.5
                if (l.dock !== undefined && l.dock > 0.5 !== prefs.dockOpen) patch.dockOpen = l.dock > 0.5
                if (Object.keys(patch).length) setPrefs(patch)
              }}
            >
              <Panel
                id="rail"
                panelRef={railRef}
                onResize={remember(railPx)}
                collapsible
                collapsedSize={0}
                defaultSize={SIZES.rail.default}
                minSize={SIZES.rail.min}
                maxSize={SIZES.rail.max}
                groupResizeBehavior="preserve-pixel-size"
              >
                {!narrow && rail}
              </Panel>
              <ResizeHandle
                orientation="horizontal"
                title="arraste para redimensionar · duplo clique recolhe/expande a rail"
                onToggle={toggleRail}
                disabled={!freeLayout}
              />
              <Panel id="chat" minSize={SIZES.chatMin}>
                <div className="h-full w-full min-h-0 min-w-0">
                  <ErrorBoundary label="Chat">
                    <ChatPane rpc={rpc} bot={bot} connState={connState} />
                  </ErrorBoundary>
                </div>
              </Panel>
              <ResizeHandle
                orientation="horizontal"
                title="arraste para redimensionar · duplo clique recolhe/expande o dock"
                onToggle={toggleDock}
                disabled={!freeLayout}
              />
              <Panel
                id="dock"
                panelRef={dockRef}
                onResize={remember(dockPx)}
                collapsible
                collapsedSize={0}
                defaultSize={SIZES.dock.default}
                minSize={SIZES.dock.min}
                maxSize={SIZES.dock.max}
                groupResizeBehavior="preserve-pixel-size"
              >
                {!narrow && dock}
              </Panel>
            </Group>
          </Panel>
          <ResizeHandle
            orientation="vertical"
            title="arraste para redimensionar · duplo clique recolhe/expande a strip"
            onToggle={toggleStrip}
            disabled={focus}
          />
          <Panel
            id="strip"
            panelRef={stripRef}
            onResize={(size) => !focus && size.inPixels > 1 && (stripPx.current = Math.round(size.inPixels))}
            collapsible
            collapsedSize={0}
            defaultSize={SIZES.strip.default}
            minSize={SIZES.strip.min}
            maxSize={SIZES.strip.max}
            groupResizeBehavior="preserve-pixel-size"
          >
            <ErrorBoundary label="Strip">
              <StatusStrip panels={regions.strip} />
            </ErrorBoundary>
          </Panel>
        </Group>

        {/* Janela estreita: rail e dock viram gavetas sobre o chat. */}
        {narrow && railOverlay && !focus && (
          <Drawer side="left" onClose={() => setRailOverlay(false)}>
            {rail}
          </Drawer>
        )}
        {narrow && dockOverlay && !focus && (
          <Drawer side="right" onClose={() => setDockOverlay(false)}>
            {dock}
          </Drawer>
        )}
        {/* modo foco: saída pelo ◎ da topbar (ativo/âmbar) ou ⌘. — sem botão flutuante sobre o header do chat */}
      </div>

      {palette && (
        <ErrorBoundary label="Paleta">
          <CommandPalette items={paletteItems} onClose={() => setPalette(false)} />
        </ErrorBoundary>
      )}
      {settings && (
        <ErrorBoundary label="Configurações" className="fixed inset-y-0 right-0 z-50 w-[min(380px,100vw)] border-l border-edge2 bg-panel">
        <SettingsPanel
          initialTab={settings}
          theme={theme}
          onTheme={(t) => setTheme(t)}
          regions={regions}
          onRegions={setRegions}
          onResetRegions={() => setRegionsState(resetRegions())}
          onResetSizes={resetSizes}
          onClose={() => setSettings(null)}
        />
        </ErrorBoundary>
      )}
    </div>
  )
}

function Drawer({ side, onClose, children }: { side: 'left' | 'right'; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="no-drag absolute inset-0 z-30 flex bg-void/50" onMouseDown={onClose}>
      <div
        className={`h-full w-[min(360px,85%)] shadow-2xl ${
          side === 'left' ? 'border-r' : 'ml-auto border-l'
        } border-edge2`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

// Largura "lógica" (descontando a escala da UI) abaixo do breakpoint.
function useNarrow(scale: number): boolean {
  const calc = () => window.innerWidth / (scale / 100) < NARROW_PX
  const [narrow, setNarrow] = useState(calc)
  useEffect(() => {
    const on = () => setNarrow(calc())
    on()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale])
  return narrow
}

// Modo navegador (dev:web): sem bridge do Electron, conecta com URL + token.
function ManualConnect({ onDone }: { onDone: () => void }) {
  const [url, setUrl] = useState('http://127.0.0.1:8642')
  const [token, setToken] = useState('')
  return (
    <div className="flex h-full items-center justify-center bg-void p-8">
      <form
        className="w-full max-w-md rounded-lg border border-edge bg-panel p-6"
        onSubmit={(e) => {
          e.preventDefault()
          saveManual(url, token)
          onDone()
        }}
      >
        <div className="label mb-1">Modo navegador</div>
        <h1 className="font-display mb-4 text-xl">Conectar ao hermes serve</h1>
        <label className="label mb-1 block">Base URL</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="mb-3 w-full rounded border border-edge bg-void px-3 py-2 text-ink focus:border-amber focus:outline-none"
        />
        <label className="label mb-1 block">Session token</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="token do serve"
          className="mb-4 w-full rounded border border-edge bg-void px-3 py-2 text-ink focus:border-amber focus:outline-none"
        />
        <button
          type="submit"
          className="w-full rounded bg-amber py-2 text-[12px] font-semibold text-void hover:brightness-110"
        >
          Conectar
        </button>
      </form>
    </div>
  )
}
