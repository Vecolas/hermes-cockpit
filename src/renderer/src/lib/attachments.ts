// Anexos do composer. Contratos RPC (tui_gateway/methods_prompt.py), no runtime session_id:
//  - imagem: image.attach {path} → fallback image.attach_bytes {content_base64, filename}
//    (ficam na sessão e vão junto do próximo prompt.submit); remover = image.detach {path}
//  - demais (inclui PDF): file.attach {path} → fallback {data_url, name}; devolve ref_text
//    (`@file:...`) que entra no texto do prompt. PDF usa file.attach (universal) — pdf.attach
//    exigiria pdftoppm e converteria em imagens, então não é usado.
import type { HermesRpc } from './rpc'

export type AttachKind = 'image' | 'pdf' | 'file'
export type AttachStatus = 'staging' | 'ready' | 'error'

export interface Attachment {
  id: string
  name: string
  kind: AttachKind
  size: number
  status: AttachStatus
  error?: string
  /** image.* — caminho no gateway, usado por image.detach */
  stagedPath?: string
  /** file.attach — `@file:...` para o texto do prompt */
  refText?: string
}

/** limite do gateway para bytes inline (image.attach_bytes = 25 MB); vale p/ fallback base64 */
export const INLINE_MAX_BYTES = 25 * 1024 * 1024

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif)$/i

export function kindOf(file: { name: string; type?: string }): AttachKind {
  if (file.type?.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image'
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return 'pdf'
  return 'file'
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error ?? new Error('falha ao ler o arquivo'))
    r.readAsDataURL(file)
  })
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

type Staged = Pick<Attachment, 'stagedPath' | 'refText'>

export async function stageFile(rpc: HermesRpc, sessionId: string, file: File, kind: AttachKind): Promise<Staged> {
  const path = window.hermes?.pathForFile?.(file) || ''
  const tooBig = () => new Error(`arquivo grande demais para envio inline (${formatSize(file.size)}; máx ${formatSize(INLINE_MAX_BYTES)})`)

  if (kind === 'image') {
    if (path) {
      try {
        const r = await rpc.call<{ attached?: boolean; path?: string }>('image.attach', { session_id: sessionId, path })
        if (r?.attached) return { stagedPath: r.path ?? path }
      } catch {
        /* caminho não visível ao gateway → bytes */
      }
    }
    if (file.size > INLINE_MAX_BYTES) throw tooBig()
    const dataUrl = await readDataUrl(file)
    const r = await rpc.call<{ attached?: boolean; path?: string }>('image.attach_bytes', {
      session_id: sessionId,
      content_base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      filename: file.name || undefined,
    })
    if (!r?.attached || !r.path) throw new Error('o gateway não aceitou a imagem')
    return { stagedPath: r.path }
  }

  type FileRes = { attached?: boolean; ref_text?: string }
  if (path) {
    try {
      const r = await rpc.call<FileRes>('file.attach', { session_id: sessionId, path, name: file.name || undefined })
      if (r?.attached && r.ref_text) return { refText: r.ref_text }
    } catch {
      /* cai para data_url */
    }
  }
  if (file.size > INLINE_MAX_BYTES) throw tooBig()
  const data_url = await readDataUrl(file)
  const r = await rpc.call<FileRes>('file.attach', { session_id: sessionId, data_url, name: file.name || 'arquivo' })
  if (!r?.attached || !r.ref_text) throw new Error('o gateway não devolveu a referência do arquivo')
  return { refText: r.ref_text }
}

export function detachImage(rpc: HermesRpc, sessionId: string, stagedPath: string): void {
  rpc.call('image.detach', { session_id: sessionId, path: stagedPath }).catch(() => {})
}

export const attachErrorText = msg
