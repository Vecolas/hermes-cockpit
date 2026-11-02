// Fronteiras de plataforma do main process. macOS é o alvo primário; Windows é
// suportado com degradação honesta onde a feature depende de POSIX/macOS
// (PTY, ps/lsof, osascript, captura de áudio do sistema).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

/** Diretórios extras onde CLIs de usuário costumam morar (app aberto pela GUI tem PATH mínimo). */
export function extraBinDirs(): string[] {
  const home = homedir()
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return [join(home, '.local', 'bin'), join(roaming, 'npm'), join(local, 'Programs'), join(local, 'Microsoft', 'WinGet', 'Links')]
  }
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

/** Nomes de arquivo possíveis de um executável na plataforma. */
export function exeNames(bin: string): string[] {
  return IS_WIN ? [`${bin}.exe`, `${bin}.cmd`, `${bin}.bat`] : [bin]
}

/** Procura `bin` nos diretórios dados; devolve o caminho absoluto ou null. */
export function findExecutable(bin: string, dirs: string[] = extraBinDirs()): string | null {
  for (const dir of dirs) {
    for (const name of exeNames(bin)) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** `.cmd`/`.bat` só executam via shell no Windows (Node recusa spawn direto). */
export const needsShell = (file: string): boolean => IS_WIN && /\.(cmd|bat)$/i.test(file)

/** Python de um venv (`bin/python` vs `Scripts/python.exe`). */
export function venvPython(venvDir: string): string {
  return IS_WIN ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python')
}

/**
 * Instalação do Hermes Agent, independente do perfil ativo: HERMES_AGENT_DIR →
 * `$HERMES_HOME/hermes-agent` → instalação inferida de HERMES_BIN → diretório
 * oficial em LOCALAPPDATA no Windows → `~/.hermes/hermes-agent`. Só vale
 * candidato cujo python do venv existe. Sem nenhum válido, devolve o primeiro
 * (erro explícito depois).
 */
export function resolveHermesAgent(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): { agentDir: string; python: string } {
  const binHome = env.HERMES_BIN ? dirname(dirname(env.HERMES_BIN)) : undefined
  const candidates = [
    env.HERMES_AGENT_DIR,
    env.HERMES_HOME ? join(env.HERMES_HOME, 'hermes-agent') : undefined,
    binHome ? join(binHome, 'hermes-agent') : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'hermes', 'hermes-agent') : undefined,
    join(home, '.hermes', 'hermes-agent'),
  ].filter((d): d is string => !!d)
  const agentDir = candidates.find((d) => exists(venvPython(join(d, 'venv')))) ?? candidates[0]
  return { agentDir, python: venvPython(join(agentDir, 'venv')) }
}

/** `p` é `root` ou está dentro dele (separador da plataforma; case-insensitive no Windows). */
export function isInside(root: string, p: string): boolean {
  const norm = (s: string) => (IS_WIN ? s.toLowerCase() : s)
  const r = norm(root)
  const q = norm(p)
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Encerra o processo e seus descendentes. POSIX: sinal no grupo (-pid, requer
 * detached) com fallback no pid. Windows não tem sinais nem grupos: `taskkill /T`
 * derruba a árvore; só existe encerramento forçado (/F), sem fase graciosa.
 */
export function killTree(child: ChildProcess, sig: NodeJS.Signals = 'SIGTERM'): void {
  const pid = child.pid
  if (!pid) return
  if (IS_WIN) {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      k.on('error', () => {
        try {
          child.kill()
        } catch {
          /* já morto */
        }
      })
    } catch {
      /* já morto */
    }
    return
  }
  try {
    process.kill(-pid, sig)
    return
  } catch {
    /* grupo já sumiu ou não é líder — tenta o pid direto */
  }
  try {
    child.kill(sig)
  } catch {
    /* já morto */
  }
}
