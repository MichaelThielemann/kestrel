import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveServerKestrel, serverRuntimeConfig } from '../../../core/server/utils/server-config'

// The session REVOCATION epoch: a monotonic counter folded into the signing key (see deriveSigningKey), so
// bumping it invalidates every outstanding token at once — the stateless model's server-side "hard logout".
// Persisted to a file in the data dir so it survives a restart. Cached in-process, but the cache is
// mtime-validated on read, so a bump by a SIBLING process (a `db:migrate` task, a second worker, a CLI
// force-logout) is observed on the next request instead of only after a restart.

let cached: number | undefined
let cachedMtimeMs = -1

/** Where the epoch persists: `KESTREL_SESSION_EPOCH_FILE`, else next to the DB. Null for a `:memory:` DB
 *  (tests) → the epoch still works in-process, it just doesn't survive a restart. */
function epochPath(): string | null {
  const override = process.env.KESTREL_SESSION_EPOCH_FILE?.trim()
  if (override) return override
  // Resolve the DB the same way useDb() does — the consumer's `kestrel: { db }` via runtimeConfig first,
  // Kestrel's own config + env only as the non-Nitro fallback. Landing anywhere else would put revocation
  // state outside the volume the operator persists, so a restart would resurrect revoked sessions.
  const fromRc = serverRuntimeConfig()?.kestrel as { dbPath?: string } | undefined
  const dbPath = fromRc?.dbPath || resolveServerKestrel().dbPath
  if (!dbPath || dbPath === ':memory:') return null
  return join(dirname(dbPath), '.kestrel-session-epoch')
}

/** `null` means "couldn't tell" (unreadable, or present but not a valid epoch) — distinct from the genuine
 *  ENOENT baseline of 0, so a caller never mistakes "the file is broken" for "never revoked". */
function readEpoch(path: string): number | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0
    console.error('[kestrel auth] could not read the session epoch file (keeping the last known epoch):', (error as Error)?.message ?? error)
    return null
  }
  const n = parseInt(raw.trim(), 10)
  if (Number.isFinite(n) && n >= 0) return n
  console.error(`[kestrel auth] session epoch file has unreadable content, ignoring it (keeping the last known epoch): ${JSON.stringify(raw.slice(0, 40))}`)
  return null
}

/** The file's mtime in ms, or -1 when absent/unreadable (a stable sentinel distinct from any real mtime). */
function epochMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return -1
  }
}

/** The current epoch. Cached in-process, but re-read from the file whenever its mtime moved — so a
 *  cross-process bump takes effect on the next call, not only after a restart. The stat is one cheap
 *  syscall per request (no content read on the common unchanged path). */
export function currentSessionEpoch(): number {
  const path = epochPath()
  if (!path) {
    // No persistence (`:memory:`): the in-process bump is the only source of truth.
    if (cached === undefined) cached = 0
    return cached
  }
  const mtime = epochMtime(path)
  if (cached === undefined || mtime !== cachedMtimeMs) {
    // A `null` read (broken file) must never regress an already-higher in-process value — take the max
    // rather than adopting it outright, the same guard bumpSessionEpoch already applies to its own re-read.
    cached = Math.max(cached ?? 0, readEpoch(path) ?? 0)
    cachedMtimeMs = mtime
  }
  return cached
}

/** Revoke every currently-issued session (logout / force-logout): increment + persist the epoch so the
 *  derived signing key changes and all outstanding tokens fail verification immediately. Best-effort
 *  persistence — a failed write still revokes for this process's lifetime (the in-process bump). */
export function bumpSessionEpoch(): void {
  const next = currentSessionEpoch() + 1
  cached = next
  const path = epochPath()
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, String(next), 'utf8')
    // Re-read AFTER writing and take the max: a sibling process may have written a HIGHER epoch between our
    // write and this read. The epoch is monotonic, so max is correct — and it closes the write→stat TOCTOU
    // where adopting only our own mtime+value could permanently mask a concurrent revocation.
    cached = Math.max(next, readEpoch(path) ?? 0)
    cachedMtimeMs = epochMtime(path)
  } catch (error) {
    console.error('[kestrel auth] could not persist session epoch (revocation holds for this process only):', (error as Error)?.message ?? error)
  }
}

/** Test hook: drop the in-process cache so a test controls the epoch via its file/env. */
export function _resetSessionEpochCache(): void { cached = undefined; cachedMtimeMs = -1 }
