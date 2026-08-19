// Cell rendering for the collection list: how a raw row value becomes the string in a table cell.
import type { ListColumn } from './list-columns'
import { humanizeFieldName } from '../../../ui/app/utils/humanize'

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' })
// A date-only value ('YYYY-MM-DD', from a datetime field with precision 'date') parses as UTC midnight;
// formatting it in the local zone would shift the calendar day, so pin it to UTC. Full ISO timestamps
// (createdAt/updatedAt carry a 'Z') and local datetimes keep the local-zone formatter.
const dateOnlyFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' })

export function isDateColumn(col: ListColumn): boolean {
  return col.key === 'createdAt' || col.key === 'updatedAt' || col.field?.type === 'datetime'
}

export function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value.replace(/<[^>]*>/g, '').slice(0, 80)
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 80)
  return String(value)
}

export function cellDisplay(col: ListColumn, row: Record<string, unknown>): string {
  const value = row[col.key]
  if (isDateColumn(col) && value != null) {
    const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    const d = new Date(value as string)
    if (!Number.isNaN(d.getTime())) return (dateOnly ? dateOnlyFmt : dateFmt).format(d)
  }
  return cellText(value)
}

/** A column header's text: a field column humanizes its own name, chrome columns translate a key. */
export function columnLabel(col: ListColumn, t: (key: string) => string): string {
  return col.type === 'field' ? humanizeFieldName(col.name ?? col.key) : t(col.labelKey ?? col.key)
}

/** A row's human label: the first visible non-sidecar cell that has a value, else the bare id — used for
 *  the per-row checkbox / action aria-labels so each control names its row. */
export function rowLabel(columns: ListColumn[], row: Record<string, unknown>): string {
  for (const c of columns) {
    if (c.type === 'translations' || c.type === 'deadRefs') continue
    const d = cellDisplay(c, row)
    if (d) return d
  }
  return `#${row.id}`
}
