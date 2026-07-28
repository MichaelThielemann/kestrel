import { ref } from 'vue'
import type { Ref } from 'vue'
import type { FieldDef } from '../../../core/server/utils/defineCollection'
import { reorder } from '../utils/reorder'
import { useEchoGuard } from './useEchoGuard'

export interface UseRepeater {
  rows: Ref<Record<string, unknown>[]>
  keys: Ref<number[]>
  addRow: () => void
  removeRow: (i: number) => void
  move: (from: number, to: number) => void
  setCell: (i: number, key: string, val: unknown) => void
  insertRow: (at: number) => void
  duplicateRow: (i: number) => void
}

export function useRepeater(
  model: Ref<Record<string, unknown>[] | null | undefined>,
  subFields: Ref<Record<string, FieldDef>>,
): UseRepeater {
  let seq = 0

  function cloneRows(v: unknown): Record<string, unknown>[] {
    if (!Array.isArray(v)) return []
    return (v as Record<string, unknown>[]).map(r => ({ ...r }))
  }

  const rows = ref<Record<string, unknown>[]>(cloneRows(model.value))
  const keys = ref<number[]>(rows.value.map(() => seq++))

  function emit(): void {
    model.value = rows.value.map(r => ({ ...r }))
  }

  function reseed(v: Record<string, unknown>[] | null | undefined): void {
    rows.value = cloneRows(v)
    keys.value = rows.value.map(() => seq++)
  }

  // Echo-guard via the shared primitive: skip our own emit, reseed on a genuine external change. Compares
  // against the CURRENT rows (not a one-shot token) so an undo→redo back to a prior value still reseeds.
  useEchoGuard(model, () => rows.value, reseed, [])

  function blankRow(): Record<string, unknown> {
    return Object.fromEntries(
      Object.keys(subFields.value).map(k => [k, subFields.value[k]!.default ?? null]),
    )
  }

  function addRow(): void {
    rows.value = [...rows.value, blankRow()]
    keys.value = [...keys.value, seq++]
    emit()
  }

  function insertRow(at: number): void {
    const clamped = Math.max(0, Math.min(at, rows.value.length))
    const newRows = [...rows.value]
    const newKeys = [...keys.value]
    newRows.splice(clamped, 0, blankRow())
    newKeys.splice(clamped, 0, seq++)
    rows.value = newRows
    keys.value = newKeys
    emit()
  }

  function duplicateRow(i: number): void {
    if (i < 0 || i >= rows.value.length) return
    const clone = JSON.parse(JSON.stringify(rows.value[i])) as Record<string, unknown>
    const newRows = [...rows.value]
    const newKeys = [...keys.value]
    newRows.splice(i + 1, 0, clone)
    newKeys.splice(i + 1, 0, seq++)
    rows.value = newRows
    keys.value = newKeys
    emit()
  }

  function removeRow(i: number): void {
    rows.value = rows.value.filter((_, idx) => idx !== i)
    keys.value = keys.value.filter((_, idx) => idx !== i)
    emit()
  }

  function move(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= rows.value.length || to >= rows.value.length) return
    rows.value = reorder(rows.value, from, to)
    keys.value = reorder(keys.value, from, to)
    emit()
  }

  function setCell(i: number, key: string, val: unknown): void {
    rows.value = rows.value.map((r, idx) => idx === i ? { ...r, [key]: val } : r)
    emit()
  }

  return { rows, keys, addRow, removeRow, move, setCell, insertRow, duplicateRow }
}
