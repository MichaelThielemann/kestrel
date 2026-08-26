import { sql, getTableColumns, getTableName, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { allCollections, fieldIs, resolveColumnName  } from '@michaelthielemann/kestrel-core'

/** One reference to a media id: which collection/record/field holds it.
 * @public
 */
export interface MediaUsage { collection: string; recordId: number; field: string }

/**
 * Reverse lookup for a whole set of media ids at once: ONE query per (collection, column), never one per
 * id. The JSON columns can only be searched by a full table scan, and better-sqlite3 is synchronous, so a
 * per-id loop over a folder-sized selection would block the event loop for seconds. Every requested id
 * gets an entry (empty when unreferenced). Mirrors `findReferrersForMany` in core's record-ref index.
 *
 * ADR-0012 ownership exemption: this scans every OTHER collection's table by design (`allCollections()`,
 * skipping `media` itself below) — a reverse-usage index, not media's own data. It stays on the raw,
 * unscoped `BetterSQLite3Database` deliberately; passing the media-scoped `MediaDb` adapter in here would
 * throw `OwnershipViolation` on its very first (legitimate) foreign read.
 *
 * `record_refs`'s extraction (`extractRecordRefs`) does not index a plain `json`-typed field, only
 * `repeater`/`relation`/`media`/`link`/`richtext`/blocks/`seo` — this function's `scanJson` branch also
 * treats a bare `json` field as scannable (a coarse over-approximation: any integer atom in range counts
 * as a usage). Routing through `record_refs` instead would silently drop usage detection for media ids
 * embedded in `json` fields.
 * @public
 */
export function findMediaUsagesForMany(db: BetterSQLite3Database, ids: number[]): Record<number, MediaUsage[]> {
  const out: Record<number, MediaUsage[]> = {}
  for (const id of ids) out[id] = []
  if (!ids.length) return out
  // The id set travels as ONE bound parameter (a JSON array), not one placeholder per id: a recursive
  // folder delete can hand us tens of thousands of ids, well past SQLite's 32766-variable ceiling.
  const idSet = sql`(select value from json_each(${JSON.stringify(ids)}))`

  for (const c of allCollections()) {
    if (c.name === 'media') continue
    const cols = getTableColumns(c.table) as Record<string, AnySQLiteColumn>
    const tbl = sql.identifier(getTableName(c.table))
    const rowId = sql.identifier(cols.id.name)
    const collect = (query: SQL, field: string) => {
      for (const r of db.all(query) as { rid: number; mid: number }[]) {
        out[r.mid]?.push({ collection: c.name, recordId: r.rid, field })
      }
    }
    // Media ids can nest anywhere inside a repeater/json/content/seo value — json_tree the whole column and
    // match any integer atom (a safe over-approximation for usage warnings).
    const scanJson = (column: string, field: string) => collect(
      sql`select distinct t.${rowId} as rid, jt.atom as mid from ${tbl} t, json_tree(t.${sql.identifier(column)}) jt
          where jt.type = 'integer' and jt.atom in ${idSet}`,
      field,
    )

    for (const [key, field] of Object.entries(c.def.fields)) {
      if (fieldIs(field, 'media') && !field.options?.multiple) {
        const { jsKey } = resolveColumnName(key, field)
        const col = sql.identifier(cols[jsKey].name)
        collect(sql`select t.${rowId} as rid, t.${col} as mid from ${tbl} t where t.${col} in ${idSet}`, key)
      } else if (fieldIs(field, 'media') && field.options?.multiple) {
        const col = sql.identifier(cols[key].name)
        collect(sql`select distinct t.${rowId} as rid, je.value as mid from ${tbl} t, json_each(t.${col}) je
                    where je.value in ${idSet}`, key)
      } else if (field.type === 'repeater' || field.type === 'json') {
        const { jsKey } = resolveColumnName(key, field)
        scanJson(cols[jsKey].name, key)
      }
    }
    if (c.def.blocks?.enabled) scanJson('content', 'content')
    // The `seo` system column carries the social-share image, so a page whose only reference to an asset is
    // its og:image must still be reported — otherwise deleting it silently 404s the published meta tag.
    if (c.def.seo) scanJson('seo', 'seo.image')
  }
  return out
}

/** Reverse lookup for a single media id.
 * @public
 */
export function findMediaUsages(db: BetterSQLite3Database, id: number): MediaUsage[] {
  return findMediaUsagesForMany(db, [id])[id]!
}
