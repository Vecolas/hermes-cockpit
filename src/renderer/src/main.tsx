import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ChatWindow } from './components/ChatWindow'
import { ErrorBoundary } from './components/ErrorBoundary'
import { windowParams } from './lib/windows'
import './index.css'

// Mesmo bundle para a janela principal e as janelas de chat avulsas
// (?window=chat&bot=<profile>, abertas por ops:window.open / ⌘⇧N).
const win = windowParams()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary label="Hermes Cockpit" className="bg-void">
      {win.kind === 'chat' ? <ChatWindow initialBot={win.bot} session={win.session} /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
)
