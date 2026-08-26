import type { ModuleDbBrand } from '@michaelthielemann/kestrel-core'
import type { PublishingDb } from '../src/server/db/publishing-db.js'
import type { SnapshotsDb } from '../src/server/db/snapshots.js'
import type { DepsPersistenceDb } from '../src/server/utils/publish/deps-persistence.js'
import type { PublishStatusDb } from '../src/server/utils/publish/publish-status.js'
import type { OrchestratorDb } from '../src/server/utils/publish/orchestrator.js'

// A minimal, self-contained stand-in for "a raw handle" — mirrors packages/kestrel-core/test/types.test-d.ts's
// own `raw` fixture exactly, for the same reason (avoids importing `BetterSQLite3Database` itself, which can
// trip an unrelated drizzle/TS module-resolution quirk under this package's typecheck config). It has every
// member `PublishingDb` names but none of its phantom brand — same shape a raw drizzle/better-sqlite3
// instance presents.
declare const raw: {
  select: PublishingDb['select']
  selectDistinct: PublishingDb['selectDistinct']
  insert: PublishingDb['insert']
  update: PublishingDb['update']
  delete: PublishingDb['delete']
  prepare: PublishingDb['prepare']
  transaction: PublishingDb['transaction']
}

// @ts-expect-error an unbranded value — even one with every real member — is not a PublishingDb
const _asPublishingDb: PublishingDb = raw

// The brand survives Pick-narrowing ONLY when the narrowed type re-intersects it (Pick alone drops any key
// outside the ones it names) — this pins that pattern for each of `@michaelthielemann/kestrel-publishing`'s own narrowed Db
// types, mirroring `record-ref-index.ts`'s own DB/WriteDB/RebuildDB and `@michaelthielemann/kestrel-core`'s own
// `types.test-d.ts` pin for the same shape.

// @ts-expect-error the narrowed type still requires the brand; an unbranded value doesn't carry it
const _asSnapshotsDb: SnapshotsDb = { select: raw.select, insert: raw.insert, update: raw.update, transaction: raw.transaction }

// @ts-expect-error the narrowed type still requires the brand; an unbranded value doesn't carry it
const _asDepsPersistenceDb: DepsPersistenceDb = { select: raw.select, insert: raw.insert, delete: raw.delete }

// @ts-expect-error the narrowed type still requires the brand; an unbranded value doesn't carry it
const _asPublishStatusDb: PublishStatusDb = { select: raw.select, insert: raw.insert, delete: raw.delete }

// @ts-expect-error the narrowed type still requires the brand; an unbranded value doesn't carry it
const _asOrchestratorDb: OrchestratorDb = { select: raw.select, insert: raw.insert, update: raw.update, prepare: raw.prepare }

// A genuinely branded value (obtained the only legitimate way — cast at a trusted construction site, same
// as makeModuleDb's own) IS assignable, narrowed or not — the brand blocks unbranded values, not real ones.
declare const publishingDb: PublishingDb
const _snapshotsViaBranded: SnapshotsDb = publishingDb
const _depsPersistenceViaBranded: DepsPersistenceDb = publishingDb
const _publishStatusViaBranded: PublishStatusDb = publishingDb
const _orchestratorViaBranded: OrchestratorDb = publishingDb
void _snapshotsViaBranded
void _depsPersistenceViaBranded
void _publishStatusViaBranded
void _orchestratorViaBranded

// The brand itself is the same symbol every narrowed type re-intersects — a value branded for ONE module's
// db (any of them; there is only one ModuleDbBrand, shared package-wide) satisfies all of them structurally
// once it also carries the required members; this is not a per-module brand, only a "genuinely built by
// makeModuleDb" one. Referencing the symbol here pins that it is actually re-exported from `@michaelthielemann/kestrel-core`,
// not merely inferred.
declare const brandKey: typeof ModuleDbBrand
void brandKey
