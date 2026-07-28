import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Prefix-relative keys referenced in `text`. The charset stops at ?/#/quote/space, so query strings,
// fragments and srcset descriptors (320w, 2x) fall outside the key; the leading `/` keeps `/uploads` from
// matching `/myuploads`.
export function referencedKeys(text: string, prefix: string): Set<string> {
  const out = new Set<string>()
  const re = new RegExp(`${escapeRe(prefix)}/([A-Za-z0-9._/-]+)`, 'g')
  for (const m of text.matchAll(re)) out.add(m[1])
  return out
}

// The prunable candidates: unreferenced files that the media library OWNS. When `ownedKeys` is given, a
// file not in it (gallery ciphertext / index, or any consumer blob written via useStorageDriver) is NEVER
// a candidate — those are baked deliberately and their URLs are built at runtime, so they never appear as
// literal keys in the output. Without `ownedKeys` the legacy "prune any unreferenced key" behaviour holds.
export function planMediaPrune(files: string[], referenced: Set<string>, ownedKeys?: Set<string>): string[] {
  return files.filter((f) => !referenced.has(f) && (!ownedKeys || ownedKeys.has(f)))
}

// The storage keys the media library owns: every original + every derivative object it tracks. Used to
// scope the bake prune so it can only ever delete media-library artifacts, never extension/consumer blobs.
export function mediaOwnedKeys(rows: { storageKey?: string | null; derivatives?: Record<string, { key?: string }> | null }[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.storageKey) out.add(r.storageKey)
    for (const e of Object.values(r.derivatives ?? {})) if (e?.key) out.add(e.key)
  }
  return out
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
}

export interface PruneResult {
  kept: number
  pruned: number
}

export interface PruneOptions {
  /** Report what would be deleted without touching the filesystem. */
  dryRun?: boolean
  /** Restrict deletion to these media-library-owned keys; anything else baked under the root is kept. */
  ownedKeys?: Set<string>
  log?: (msg: string) => void
}

// Delete every baked upload under `publicDir/<baseUrl>` that no generated .html/.css/.json references.
// Over-scanning those files is keep-on-doubt (a key seen anywhere is kept). No-op when the dir is absent
// (S3 media / nothing baked). Touches only the bake — the library upload dir is elsewhere.
export function pruneUnreferencedMedia(publicDir: string, baseUrl: string, opts: PruneOptions = {}): PruneResult {
  const prefix = baseUrl.replace(/\/+$/, '')
  if (!prefix) return { kept: 0, pruned: 0 } // an empty baseUrl would target the whole output — refuse
  const uploadsDir = join(publicDir, prefix)
  if (!existsSync(uploadsDir)) return { kept: 0, pruned: 0 }

  const referenced = new Set<string>()
  for (const abs of walkFiles(publicDir)) {
    // Also scan JS chunks: a media URL can be emitted only from client JS (a background image, a config
    // object), never as literal HTML/CSS — pruning it would 404 the live reference.
    if (!/\.(?:html|css|json|m?js)$/i.test(abs)) continue
    for (const k of referencedKeys(readFileSync(abs, 'utf8'), prefix)) referenced.add(k)
  }

  const files = walkFiles(uploadsDir).map((abs) => ({ abs, key: relative(uploadsDir, abs).split(sep).join('/') }))
  const prune = new Set(planMediaPrune(files.map((f) => f.key), referenced, opts.ownedKeys))
  const toDelete = files.filter((f) => prune.has(f.key))
  if (!opts.dryRun) for (const f of toDelete) rmSync(f.abs, { force: true })

  const kept = files.length - toDelete.length
  opts.log?.(`media prune${opts.dryRun ? ' (dry-run)' : ''}: kept ${kept}, ${opts.dryRun ? 'would prune' : 'pruned'} ${toDelete.length} unreferenced file(s)`)
  return { kept, pruned: toDelete.length }
}
