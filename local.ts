// Same-machine session registry. Every peer server drops <state>/local/<name>.json while it
// runs, so sessions on one box find each other without editing PEER_ALLOW. Only this user can
// write the directory, so a live entry is trusted (it IS the user's own session).
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Peer } from './a2a.ts'

export type LocalEntry = { name: string; url: string; pid: number; project: string; ts: string }
export type LocalPeer = Peer & { project: string }

export const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

// Register this session; returns the unregister function. Refuses a name another live session holds.
export function register(dir: string, e: LocalEntry, alive = pidAlive): () => void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${e.name}.json`)
  const prev = readEntry(file)
  if (prev && prev.pid !== e.pid && alive(prev.pid)) throw new Error(`peer name "${e.name}" is already running (pid ${prev.pid}, ${prev.project}) — pick another PEER_NAME`)
  writeFileSync(file, JSON.stringify(e))
  return () => { try { unlinkSync(file) } catch {} }
}

// Live entries other than self. Stale files (dead pid) are removed on sight.
export function localPeers(dir: string, self: string, alive = pidAlive): Map<string, LocalPeer> {
  const out = new Map<string, LocalPeer>()
  let files: string[] = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return out }
  for (const f of files) {
    const file = join(dir, f), e = readEntry(file)
    if (!e) { try { unlinkSync(file) } catch {}; continue }
    if (!alive(e.pid)) { try { unlinkSync(file) } catch {}; continue }
    if (e.name === self) continue
    out.set(e.name, { url: e.url, trusted: true, host: new URL(e.url).hostname, local: true, project: e.project })
  }
  return out
}

function readEntry(file: string): LocalEntry | null {
  try {
    const e = JSON.parse(readFileSync(file, 'utf8'))
    return e && typeof e.name === 'string' && typeof e.url === 'string' && Number.isInteger(e.pid) ? { project: '', ts: '', ...e } : null
  } catch { return null }
}
