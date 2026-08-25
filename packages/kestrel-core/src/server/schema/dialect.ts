import type { SchemaSnapshot, SchemaOp } from './model.js'
import type { IntrospectDb } from './introspect.js'
import { introspect } from './introspect.js'
import { renderSqlite } from './render-sqlite.js'

// The dialect seam (ADR-0002). `model.ts` + `diffSchema` are dialect-agnostic: a diff is computed as a
// `SchemaOp[]` over the normalized model, independent of any database. A `Dialect` is what binds that
// core to a concrete backend — it knows how to read the backend's live schema back into the model
// (`introspect`), how to turn ops into the backend's DDL (`render`), and how to quote an identifier.
// `sync.ts` is threaded with a Dialect (defaulting to `sqlite`), so DDL rendering, introspection and
// identifier quoting are swappable without touching the diff. The seam stops there: `diff.ts` emits
// `rebuild_table` because SQLite has no ALTER/DROP COLUMN, and sync's pre-flight feasibility probes are
// SQLite SQL (`PRAGMA table_info`, `json_extract`) — a second backend needs both adjusted alongside its
// new Dialect. SQLite is the only implementation today; `postgres` is a reserved, fail-loud slot.
/** @public */
export interface Dialect {
  /** Stable identifier, e.g. `sqlite` | `postgres`. */
  readonly name: string
  /** Read the live database's actual schema into the normalized model, for `diffSchema` to compare. */
  introspect(db: IntrospectDb): SchemaSnapshot
  /** Render structured ops into this backend's DDL statements, preserving the apply-safe order. */
  render(ops: SchemaOp[]): string[]
  /** Quote an identifier for this backend (backticks for SQLite, double-quotes for Postgres). */
  quote(id: string): string
}

/** The SQLite dialect: the current engine, now behind the seam. `render`/`introspect` are the existing
 * @public
 *  pure functions; `quote` is SQLite's backtick quoting (matching `render-sqlite`'s own internal escape). */
export const sqlite: Dialect = {
  name: 'sqlite',
  introspect,
  render: renderSqlite,
  quote: (id) => `\`${id.replace(/`/g, '``')}\``,
}

const pgNotImplemented = (op: string) =>
  new Error(
    `kestrel: the postgres dialect is not implemented yet (Dialect.${op}). It is a reserved slot ` +
      `(ADR-0002) — a Postgres backend needs its own DDL renderer (real ALTER/DROP COLUMN, not SQLite's ` +
      `table rebuild), information_schema introspection, and a pg-typed desired snapshot. Use \`sqlite\`.`,
  )

/** Reserved Postgres slot. Every substantive entry point fails loud so a misconfiguration can never
 *  silently fall back to emitting SQLite DDL against a non-SQLite database. `quote` is the one piece that
 * @public
 *  is trivially correct (standard double-quote escaping), so it is implemented rather than thrown. */
export const postgres: Dialect = {
  name: 'postgres',
  introspect() { throw pgNotImplemented('introspect') },
  render() { throw pgNotImplemented('render') },
  quote: (id) => `"${id.replace(/"/g, '""')}"`,
}

const dialects: Record<string, Dialect> = { sqlite, postgres }

/** Resolve a dialect by name (the config-driven selection point for the migration engine). Throws a
 *  clear error naming the supported dialects rather than silently defaulting, so a typo'd or unsupported
 * @public
 *  backend fails at startup instead of mis-migrating. */
export function resolveDialect(name: string): Dialect {
  const d = dialects[name]
  if (!d) throw new Error(`kestrel: unknown database dialect "${name}" — supported: ${Object.keys(dialects).join(', ')}`)
  return d
}
