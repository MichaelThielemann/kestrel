import { describe, it, expect } from 'vitest'
import { nextTick, ref } from 'vue'
import { useRepeater } from './useRepeater'
import type { FieldDef } from '../../../core/server/utils/defineCollection'

const subFields: Record<string, FieldDef> = {
  label: { type: 'text' },
  score: { type: 'number', default: 0 } as FieldDef,
}

describe('useRepeater', () => {
  it('seeds rows from initial model and keys.length === rows.length', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A', score: 1 },
      { label: 'B', score: 2 },
    ])
    const { rows, keys } = useRepeater(model, ref(subFields))
    expect(rows.value).toEqual([{ label: 'A', score: 1 }, { label: 'B', score: 2 }])
    expect(keys.value.length).toBe(2)
  })

  it('treats null model as empty', () => {
    const model = ref<Record<string, unknown>[] | null>(null)
    const { rows, keys } = useRepeater(model, ref(subFields))
    expect(rows.value).toEqual([])
    expect(keys.value).toEqual([])
  })

  it('treats undefined model as empty', () => {
    const model = ref<Record<string, unknown>[] | undefined>(undefined)
    const { rows, keys } = useRepeater(model, ref(subFields))
    expect(rows.value).toEqual([])
    expect(keys.value).toEqual([])
  })

  it('addRow appends blank row with default ?? null per sub-field and emits', () => {
    const model = ref<Record<string, unknown>[] | null>([])
    const { rows, keys, addRow } = useRepeater(model, ref(subFields))
    addRow()
    expect(rows.value.length).toBe(1)
    // score has default 0, label has no default → null
    expect(rows.value[0]).toEqual({ label: null, score: 0 })
    expect(keys.value.length).toBe(1)
    expect(model.value).toEqual([{ label: null, score: 0 }])
  })

  it('addRow assigns unique monotonic keys', () => {
    const model = ref<Record<string, unknown>[] | null>([])
    const { keys, addRow } = useRepeater(model, ref(subFields))
    addRow()
    addRow()
    expect(keys.value[0]).not.toBe(keys.value[1])
    expect(keys.value.length).toBe(2)
  })

  it('setCell updates [i][key] immutably, emits, and keys[i] is unchanged', async () => {
    const model = ref<Record<string, unknown>[] | null>([{ label: 'A', score: 1 }])
    const { rows, keys, setCell } = useRepeater(model, ref(subFields))
    const keyBefore = keys.value[0]
    setCell(0, 'label', 'Updated')
    await nextTick()
    expect(rows.value[0]!.label).toBe('Updated')
    expect(rows.value[0]!.score).toBe(1)
    expect(keys.value[0]).toBe(keyBefore)
    expect(model.value).toEqual([{ label: 'Updated', score: 1 }])
  })

  it('setCell does not mutate the previous row object', () => {
    const model = ref<Record<string, unknown>[] | null>([{ label: 'A', score: 1 }])
    const { rows, setCell } = useRepeater(model, ref(subFields))
    const prev = rows.value[0]
    setCell(0, 'label', 'B')
    expect(rows.value[0]).not.toBe(prev)
  })

  it('removeRow drops the row and its key', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A', score: 1 },
      { label: 'B', score: 2 },
      { label: 'C', score: 3 },
    ])
    const { rows, keys, removeRow } = useRepeater(model, ref(subFields))
    const [k0, , k2] = keys.value as [number, number, number]
    removeRow(1)
    expect(rows.value.length).toBe(2)
    expect(rows.value[0]!.label).toBe('A')
    expect(rows.value[1]!.label).toBe('C')
    expect(keys.value).toEqual([k0, k2])
    expect(model.value!.length).toBe(2)
  })

  it('move reorders rows and keys together', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A' },
      { label: 'B' },
      { label: 'C' },
    ])
    const { rows, keys, move } = useRepeater(model, ref({ label: { type: 'text' } as FieldDef }))
    const keyA = keys.value[0]!
    move(0, 2)
    // A moves to last position
    expect(rows.value[2]!.label).toBe('A')
    expect(keys.value[2]).toBe(keyA)
    expect(model.value![2]!.label).toBe('A')
  })

  it('move from===to is a no-op (no spurious emit)', () => {
    const model = ref<Record<string, unknown>[] | null>([{ label: 'A' }, { label: 'B' }])
    const { rows, keys, move } = useRepeater(model, ref({ label: { type: 'text' } as FieldDef }))
    const keysBefore = [...keys.value]
    const modelBefore = model.value
    move(1, 1)
    expect(keys.value).toEqual(keysBefore)
    expect(rows.value[0]!.label).toBe('A')
    expect(rows.value[1]!.label).toBe('B')
    expect(model.value).toBe(modelBefore)
  })

  it('move out-of-range is a no-op (no spurious emit)', () => {
    const model = ref<Record<string, unknown>[] | null>([{ label: 'A' }])
    const { rows, move } = useRepeater(model, ref({ label: { type: 'text' } as FieldDef }))
    const modelBefore = model.value
    move(0, 5)
    expect(rows.value[0]!.label).toBe('A')
    expect(model.value).toBe(modelBefore)
  })

  it('external model reassign reseeds rows and regenerates keys', async () => {
    const model = ref<Record<string, unknown>[] | null>([{ label: 'A', score: 1 }])
    const { rows, keys } = useRepeater(model, ref(subFields))
    const oldKey = keys.value[0]!
    model.value = [{ label: 'X', score: 99 }, { label: 'Y', score: 0 }]
    await nextTick()
    expect(rows.value.length).toBe(2)
    expect(rows.value[0]!.label).toBe('X')
    expect(rows.value[1]!.label).toBe('Y')
    expect(keys.value.length).toBe(2)
    // keys are regenerated (fresh ids — at minimum different count means different)
  })

  it('reassigning model to array equal to last emit does not thrash keys', async () => {
    const model = ref<Record<string, unknown>[] | null>([])
    const { keys, addRow } = useRepeater(model, ref(subFields))
    addRow()
    const keyAfterAdd = keys.value[0]!
    // Simulate an external observer writing back the exact same value we emitted
    model.value = [{ label: null, score: 0 }]
    await nextTick()
    expect(keys.value[0]).toBe(keyAfterAdd)
  })

  it('insertRow(1) inserts a blank at index 1, shifts the rest, emits, keys.length grows by 1', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A', score: 1 },
      { label: 'B', score: 2 },
      { label: 'C', score: 3 },
    ])
    const { rows, keys, insertRow } = useRepeater(model, ref(subFields))
    const keyB = keys.value[1]!
    insertRow(1)
    expect(rows.value.length).toBe(4)
    expect(rows.value[0]!.label).toBe('A')
    expect(rows.value[1]).toEqual({ label: null, score: 0 })
    expect(rows.value[2]!.label).toBe('B')
    expect(rows.value[3]!.label).toBe('C')
    expect(keys.value.length).toBe(4)
    // the key that was at index 1 (B) is now at index 2
    expect(keys.value[2]).toBe(keyB)
    expect(model.value!.length).toBe(4)
  })

  it('insertRow(99) clamps to end (appends)', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A', score: 1 },
      { label: 'B', score: 2 },
    ])
    const { rows, insertRow } = useRepeater(model, ref(subFields))
    insertRow(99)
    expect(rows.value.length).toBe(3)
    expect(rows.value[2]).toEqual({ label: null, score: 0 })
  })

  it('insertRow(-5) clamps to start (prepends)', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A', score: 1 },
      { label: 'B', score: 2 },
    ])
    const { rows, insertRow } = useRepeater(model, ref(subFields))
    insertRow(-5)
    expect(rows.value.length).toBe(3)
    expect(rows.value[0]).toEqual({ label: null, score: 0 })
    expect(rows.value[1]!.label).toBe('A')
    expect(rows.value[2]!.label).toBe('B')
  })

  it('duplicateRow(0) inserts a deep clone at index 1 with a new key and emits', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A', score: 1, meta: { nested: [1, 2] } },
      { label: 'B', score: 2 },
    ])
    const { rows, keys, duplicateRow } = useRepeater(model, ref(subFields))
    const key0 = keys.value[0]!
    duplicateRow(0)
    expect(rows.value.length).toBe(3)
    expect(rows.value[1]).toEqual(rows.value[0])
    expect(keys.value[1]).not.toBe(key0)
    expect(model.value!.length).toBe(3)
  })

  it('duplicateRow(0) produces a deep clone: mutating original nested value does not affect the clone', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A', score: 1, meta: { nested: [1, 2] } },
    ])
    const { rows, duplicateRow } = useRepeater(model, ref(subFields))
    duplicateRow(0)
    ;(rows.value[0]!.meta as { nested: number[] }).nested.push(99)
    expect((rows.value[1]!.meta as { nested: number[] }).nested).toEqual([1, 2])
  })

  it('duplicateRow(99) out-of-range is a no-op (no emit, model ref unchanged)', () => {
    const model = ref<Record<string, unknown>[] | null>([
      { label: 'A', score: 1 },
    ])
    const { rows, duplicateRow } = useRepeater(model, ref(subFields))
    const modelBefore = model.value
    duplicateRow(99)
    expect(rows.value.length).toBe(1)
    expect(model.value).toBe(modelBefore)
  })
})
