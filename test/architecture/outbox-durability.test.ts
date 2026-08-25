import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

// Verifies the outbox's actual justification: a committed transaction survives the writing PROCESS dying,
// not just that our own JS logic looks atomic in-memory (outbox.test.ts's atomicity tests already cover
// that). A real child process performs one `db.transaction()` (record insert + outbox insert, the same
// shape `persist.ts` uses) against a real file-backed sqlite db, signals the commit, and is SIGKILLed
// before it does anything else — then the parent reopens the same file and reads it back.
//
// The child is plain JS (`fixtures/outbox-kill-child.mjs`), not the real TS pipeline: no TS-executing
// loader (tsx, vite-node, …) is a committed project dependency, and adding one just for this one test's
// child process was judged not worth the new dependency surface. What's under test here is SQLite/
// better-sqlite3's WAL durability guarantee under the exact pragmas `useDb()` sets — the property the real
// code depends on — not a re-run of the pipeline's own step wiring, which the unit-level `outbox.test.ts`
// already exercises thoroughly.
const childScript = fileURLToPath(new URL('./fixtures/outbox-kill-child.mjs', import.meta.url))

let tmpDir: string | undefined
let liveChild: ChildProcess | undefined

afterEach(() => {
  // On the "child never signaled COMMITTED" timeout path (or any other early throw) the child is still
  // running its keep-alive `setInterval` — clean it up so a failed run doesn't leak a hung process.
  if (liveChild && liveChild.exitCode === null && liveChild.signalCode === null) liveChild.kill('SIGKILL')
  liveChild = undefined
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = undefined
})

describe('outbox: durability across process death', () => {
  it('a commit survives SIGKILL — the record and its outbox row are both there when reopened', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kestrel-outbox-kill-'))
    const dbPath = join(tmpDir, 'test.sqlite')

    const child = spawn(process.execPath, [childScript, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    liveChild = child

    const committed = await new Promise<boolean>((resolvePromise, reject) => {
      let out = ''
      let err = ''
      const timer = setTimeout(() => reject(new Error(`child never signaled COMMITTED; stderr: ${err}`)), 10_000)
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        if (out.includes('COMMITTED')) { clearTimeout(timer); resolvePromise(true) }
      })
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
      child.on('error', reject)
    })
    expect(committed).toBe(true)

    const exited = new Promise<void>((resolvePromise) => child.on('exit', () => resolvePromise()))
    child.kill('SIGKILL')
    await exited
    liveChild = undefined

    const sqlite = new Database(dbPath)
    const record = sqlite.prepare('SELECT * FROM durability_probe').get() as { id: number, title: string } | undefined
    const outboxRow = sqlite.prepare('SELECT * FROM outbox_content').get() as
      { id: number, envelope: string, aggregate_key: string, sequence: number } | undefined
    sqlite.close()

    expect(record).toEqual({ id: 1, title: 'kill-test record' })
    expect(outboxRow?.aggregate_key).toBe('probe:1')
    expect(outboxRow?.sequence).toBe(1)
    const envelope = JSON.parse(outboxRow!.envelope) as { name: string, sequence: number, aggregate: { recordId: number } }
    expect(envelope.name).toBe('probe.created')
    expect(envelope.sequence).toBe(1)
    expect(envelope.aggregate.recordId).toBe(record!.id)
  })
})
