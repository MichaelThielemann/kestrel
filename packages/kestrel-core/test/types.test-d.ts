import type { ContentDb } from '../src/server/db/content-db.js'
import type { ModuleDbBrand } from '../src/server/db/module-db.js'

// A minimal, self-contained stand-in for "a raw handle" — deliberately NOT `BetterSQLite3Database` itself
// (importing that here can trip an unrelated drizzle/TS module-
// resolution quirk under this package's typecheck config; a plain shape with the same member names proves
// the same point without it). It has every member `ContentDb` names but none of `ContentDb`'s phantom
// brand — same shape a raw drizzle/better-sqlite3 instance presents.
declare const raw: {
  select: ContentDb['select']
  selectDistinct: ContentDb['selectDistinct']
  insert: ContentDb['insert']
  update: ContentDb['update']
  delete: ContentDb['delete']
  prepare: ContentDb['prepare']
  transaction: ContentDb['transaction']
}

// @ts-expect-error an unbranded value — even one with every real member — is not a ContentDb
const _asContentDb: ContentDb = raw

// The brand survives Pick-narrowing ONLY when the narrowed type re-intersects it (Pick alone drops any key
// outside the ones it names) — this is exactly the shape record-ref-index.ts's own DB/WriteDB/RebuildDB
// use, so this pins that pattern, not just the full ContentDb.
type Narrowed = Pick<ContentDb, 'select' | 'insert'> & { readonly [ModuleDbBrand]: true }
// @ts-expect-error the narrowed type still requires the brand; an unbranded value doesn't carry it
const _asNarrowed: Narrowed = { select: raw.select, insert: raw.insert }

// A genuinely branded value (obtained the only legitimate way — cast at a trusted construction site, same
// as makeModuleDb's own) IS assignable, narrowed or not — the brand blocks unbranded values, not real ones.
declare const contentDb: ContentDb
const _viaBranded: Narrowed = contentDb
void _viaBranded
