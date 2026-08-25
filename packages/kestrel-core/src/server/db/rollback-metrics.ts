import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Dev-side measurement primitive: appends one ndjson line `{ date, timeToRollbackSec }` to `file`,
 * creating it (and its parent directory) if missing. Never called from a production write path. `durationMs`
 * is rounded to microsecond precision because a rollback against an in-memory fixture is sub-millisecond
 * and anything past that is float noise. The caller supplies the file, so tests point it at a throwaway path.
 * @public
 */
export function recordTimeToRollback(file: string, durationMs: number): void {
  mkdirSync(dirname(file), { recursive: true })
  const timeToRollbackSec = Math.round((durationMs / 1000) * 1e6) / 1e6
  appendFileSync(file, `${JSON.stringify({ date: new Date().toISOString(), timeToRollbackSec })}\n`)
}
