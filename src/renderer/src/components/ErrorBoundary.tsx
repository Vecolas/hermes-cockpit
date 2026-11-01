import { Component, type ErrorInfo, type ReactNode } from 'react'

// Barreira de erro por painel: uma exceção de render (payload inesperado de uma
// fonte, bug num widget) vira estado de erro NESTE painel, com retry — nunca
// desmonta a árvore inteira nem deixa a janela em branco.

interface Props {
  /** nome do painel, mostrado no estado de erro */
  label: string
  /** variante compacta (uma linha) para áreas pequenas como a topbar */
  compact?: boolean
  className?: string
  children?: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[cockpit] erro de render em "${this.props.label}":`, error, info.componentStack)
  }

  private retry = (): void => this.setState({ error: null })

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const msg = error.message || String(error)
    if (this.props.compact) {
      return (
        <div className={`flex min-w-0 items-center gap-2 px-3 text-[11px] text-alert ${this.props.className ?? ''}`}>
          <span className="truncate" title={msg}>
            {this.props.label}: erro: {msg}
          </span>
          <button
            type="button"
            onClick={this.retry}
            className="no-drag shrink-0 rounded border border-alert/40 px-1.5 text-[10px] hover:bg-alert/10"
          >
            tentar de novo
          </button>
        </div>
      )
    }
    return (
      <div className={`no-drag flex h-full min-h-0 w-full min-w-0 flex-col gap-2 px-4 py-3 ${this.props.className ?? ''}`}>
        <div className="label text-alert">{this.props.label} · erro</div>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11px] text-dim">erro: {msg}</pre>
        <div>
          <button
            type="button"
            onClick={this.retry}
            className="rounded border border-alert/40 px-2 py-0.5 text-[11px] text-alert hover:bg-alert/10"
          >
            tentar de novo
          </button>
        </div>
      </div>
    )
  }
}
