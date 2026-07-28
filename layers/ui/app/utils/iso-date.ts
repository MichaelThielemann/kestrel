import { parseDate, parseDateTime, type DateValue } from '@internationalized/date'

export type IsoPrecision = 'date' | 'datetime'

/** ISO string → a `@internationalized/date` value for Reka; invalid/empty → undefined. */
export function isoToDate(iso: string | null | undefined, precision: IsoPrecision): DateValue | undefined {
  if (!iso) return undefined
  try {
    return precision === 'date' ? parseDate(iso) : parseDateTime(iso)
  } catch {
    return undefined
  }
}

/** A `@internationalized/date` value → ISO string; null/undefined → null. */
export function dateToIso(value: DateValue | null | undefined): string | null {
  return value ? value.toString() : null
}
