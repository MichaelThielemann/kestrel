import { defineNuxtModule } from '@nuxt/kit'
import Database from 'better-sqlite3'
import { resolveKestrel, type KestrelConfig } from '@michaelthielemann/kestrel-core'
import { isEnvTrue } from '@michaelthielemann/kestrel-delivery-static'
import { pruneUnreferencedMedia, mediaOwnedKeys } from './prune-media'

// The set of storage keys the media library owns (originals + derivatives), read straight from the DB at
// build time. Returns null when the registry can't be read (no DB, no media table) — the caller then SKIPS
// the prune entirely rather than risk deleting extension/consumer blobs (e.g. gallery ciphertext).
function readOwnedKeys(dbPath: string): Set<string> | null {
  if (dbPath === ':memory:') return null
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      const rows = db.prepare('SELECT storage_key AS storageKey, derivatives FROM media').all() as { storageKey: string; derivatives: string | null }[]
      return mediaOwnedKeys(rows.map((r) => ({ storageKey: r.storageKey, derivatives: r.derivatives ? JSON.parse(r.derivatives) : null })))
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

// `nuxt generate` bakes the WHOLE upload dir into .output/public/<baseUrl>; without this, images of
// deleted/unpublished pages ship to prod. At `compiled` (full output on disk, post prerender-abort) delete
// every baked media file no generated page references — prunes the BAKE only, so a wrong prune costs a
// re-generate, not data. Local-driver only (only it registers the /uploads publicAssets that gets baked).
// If deploy-output is ever added to modules[], it must come AFTER this so the prune runs before the ship.
export default defineNuxtModule({
  meta: { name: 'kestrel-prune-media' },
  setup(_options, nuxt) {
    const c = resolveKestrel(nuxt.options.kestrel as KestrelConfig, process.env, nuxt.options.rootDir)
    if (c.media.driver !== 'local') return
    const dryRun = isEnvTrue(process.env.KESTREL_OUTPUT_DRY_RUN)
    nuxt.hook('nitro:init', (nitro) => {
      nitro.hooks.hook('compiled', () => {
        if (nitro.options.static !== true) return
        const ownedKeys = readOwnedKeys(c.dbPath)
        if (!ownedKeys) {
          console.log('[kestrel] media prune skipped: media registry unavailable (would risk deleting extension/consumer blobs)')
          return
        }
        pruneUnreferencedMedia(nitro.options.output.publicDir, c.media.baseUrl, { dryRun, ownedKeys, log: (m) => console.log(`[kestrel] ${m}`) })
      })
    })
  },
})
