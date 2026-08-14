import { and, eq, like, count, getTableColumns, sql, isNull, or, asc, desc } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'
import { media } from '../collections/media'
import { folders as foldersTable } from '../database/folders'
import { resolveMedia } from './resolve'
import { childName, isImmediateChild } from './folder-paths'
import { primaryLocale } from '../../../core/server/utils/locale'
import { escapeLike } from '../../../core/server/utils/sql'

export interface LibraryQuery { folder?: string; search?: string; type?: 'image' | 'all'; page?: number; perPage?: number; sort?: string }
export interface LibraryFolder { path: string; name: string; size: number }

// Sortable table columns → media column. `sort` is `field` (asc) or `-field` (desc); unknown → name.
const SORT_FIELDS = ['name', 'size', 'type'] as const
function parseSort(sort: string | undefined): { field: (typeof SORT_FIELDS)[number]; desc: boolean } {
  const isDesc = (sort ?? '').startsWith('-')
  const field = (sort ?? '').replace(/^-/, '') as (typeof SORT_FIELDS)[number]
  return { field: SORT_FIELDS.includes(field) ? field : 'name', desc: isDesc }
}

export function listLibrary(db: BetterSQLite3Database, q: LibraryQuery, publicUrl: (key: string) => string) {
  const folder = q.folder ?? ''
  const cols = getTableColumns(media) as Record<string, never>
  const t = media as AnySQLiteTable

  // root files are stored with folder NULL (the uploader maps '' → null), so match both at root
  const conds = [folder === '' ? or(isNull(cols.folder), eq(cols.folder, '')) : eq(cols.folder, folder)]
  if (q.search) conds.push(sql`${cols.filename} like ${`%${escapeLike(q.search)}%`} escape '\\'`)
  if (q.type === 'image') conds.push(like(cols.mime, 'image/%'))
  const where = and(...conds)

  // `?? default` catches only null/undefined, NOT NaN (`?perPage=abc` → Number('abc') === NaN), and
  // .limit(NaN) binds LIMIT NULL / 500s in SQLite — guard with Number.isFinite (mirrors crud.list).
  const num = (v: number | undefined, fallback: number) => (Number.isFinite(v) ? (v as number) : fallback)
  const page = Math.max(1, Math.floor(num(q.page, 1)))
  const perPage = Math.min(200, Math.max(1, Math.floor(num(q.perPage, 60))))

  // Files are paginated, so sorting must happen in SQL. Tie-break by filename for a stable order.
  const sort = parseSort(q.sort)
  const sortCol = sort.field === 'size' ? cols.size : sort.field === 'type' ? cols.mime : cols.filename
  const dir = sort.desc ? desc : asc
  const rows = db.select().from(t).where(where).orderBy(dir(sortCol), asc(cols.filename))
    .limit(perPage).offset((page - 1) * perPage).all() as Record<string, unknown>[]
  const totalRow = db.select({ value: count() }).from(t).where(where).get() as { value: number } | undefined

  // Resolve in the configured PRIMARY locale — the same locale the viewer edits alt in (and the locale
  // resolveMedia itself falls back to), so an alt edit round-trips into the list for any primary, not
  // just 'en'. A literal 'en' here would let an 'en' translation mask a non-en primary's alt.
  const locale = primaryLocale()
  const files = rows.map((r) => {
    const m = resolveMedia(r as never, locale, publicUrl)
    // serialize the webp ladder to an <img srcset> string; non-derivable files (pdf/svg) → undefined
    // so the grid renders its ext badge instead of a broken <img> (an empty array is truthy)
    const srcset = m.srcset.length ? m.srcset.map((s) => `${s.url} ${s.width}w`).join(', ') : undefined
    return {
      id: m.id, filename: r.filename as string, mime: m.mime, folder: r.folder as string,
      size: r.size as number, width: m.width, height: m.height, thumbhash: m.thumbhash,
      src: m.src, srcset, alt: m.alt, aiDisclosure: m.aiDisclosure,
      createdAt: r.createdAt as Date, updatedAt: r.updatedAt as Date,
    }
  })

  const allFolders = db.select({ path: foldersTable.path }).from(foldersTable).all()

  // Recursive folder sizes: one grouped query sums bytes per exact folder across the current subtree,
  // then each immediate child's whole subtree is rolled up in JS (cheap: one row per distinct folder).
  const sizeBase = db.select({ folder: cols.folder, total: sql<number>`coalesce(sum(${cols.size}), 0)` }).from(t).groupBy(cols.folder)
  const sizeRows = (folder === ''
    ? sizeBase
    : sizeBase.where(or(eq(cols.folder, folder), sql`${cols.folder} like ${`${escapeLike(folder)}/%`} escape '\\'`))
  ).all() as { folder: string | null; total: number }[]
  const sizeOf = (prefix: string): number =>
    sizeRows.reduce((sum, r) => (((r.folder ?? '') === prefix || (r.folder ?? '').startsWith(`${prefix}/`)) ? sum + Number(r.total ?? 0) : sum), 0)

  // Folders always render before files; within the group they follow the same sort (by name, or by
  // recursive size; type is uniform for folders so it falls back to name).
  const folderList: LibraryFolder[] = allFolders
    .filter((f) => isImmediateChild(folder, f.path))
    .map((f) => ({ path: f.path, name: childName(f.path), size: sizeOf(f.path) }))
    .sort((a, b) => {
      const c = sort.field === 'size' ? a.size - b.size : a.name.localeCompare(b.name)
      return sort.desc ? -c : c
    })

  // The root always exists; any other folder must have a row in the registry. Lets the client tell a
  // genuinely-empty folder apart from a path that does not exist (→ error instead of a blank listing).
  const exists = folder === '' || allFolders.some((f) => f.path === folder)

  return { folder, exists, folders: folderList, files, total: Number(totalRow?.value ?? 0), page, perPage }
}
