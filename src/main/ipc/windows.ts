import { ipcMain } from 'electron'

// Janelas extras (chat avulso). O index.ts injeta a fábrica de janelas para
// não haver import circular. Canal: ops:window.open({kind:'chat', bot?}).

type Factory = (query: Record<string, string>) => void
let factory: Factory | null = null

export function setWindowFactory(f: Factory): void {
  factory = f
}

const BOT_RE = /^[\w.-]{1,64}$/

export function register(): void {
  ipcMain.handle('ops:window.open', (_e, opts: { kind?: unknown; bot?: unknown; session?: unknown; title?: unknown } = {}) => {
    if (!factory) throw new Error('fábrica de janelas não registrada')
    const query: Record<string, string> = { window: 'chat' }
    if (typeof opts.bot === 'string' && BOT_RE.test(opts.bot)) query.bot = opts.bot
    if (typeof opts.session === 'string' && /^[\w.:-]{1,128}$/.test(opts.session)) query.session = opts.session
    if (typeof opts.title === 'string') query.title = opts.title.slice(0, 120)
    factory(query)
  })
}
