// Toasts globais. CONTRATO (fixo): qualquer módulo chama toast({...}); o
// <Toaster/> montado no App renderiza. Sem Toaster montado, vira console.info.
export type ToastTone = 'info' | 'ok' | 'warn' | 'error'
export interface ToastInput {
  title: string
  detail?: string
  tone?: ToastTone
  /** ms; 0 = fica até fechar. padrão 4000 (error: 8000) */
  durationMs?: number
}
export interface ToastItem extends ToastInput {
  id: number
}

type Listener = (items: ToastItem[]) => void
let items: ToastItem[] = []
let seq = 0
const listeners = new Set<Listener>()

function emit(): void {
  for (const l of listeners) l(items)
}

export function toast(t: ToastInput): number {
  const id = ++seq
  if (!listeners.size) console.info('[toast]', t.title, t.detail ?? '')
  items = [...items, { ...t, id }].slice(-5)
  emit()
  const ms = t.durationMs ?? (t.tone === 'error' ? 8000 : 4000)
  if (ms > 0) setTimeout(() => dismissToast(id), ms)
  return id
}

export function dismissToast(id: number): void {
  items = items.filter((x) => x.id !== id)
  emit()
}

export function subscribeToasts(l: Listener): () => void {
  listeners.add(l)
  l(items)
  return () => {
    listeners.delete(l)
  }
}
