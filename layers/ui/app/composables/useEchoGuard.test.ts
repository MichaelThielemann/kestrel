import { describe, it, expect, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { useEchoGuard } from './useEchoGuard'

describe('useEchoGuard', () => {
  it('skips our own emit but reseeds on a genuine external change — incl. a return to a previously-seen value', async () => {
    const model = ref<number[] | null>([])
    let local: number[] = []
    const reseeds: string[] = []
    useEchoGuard(model, () => local, (v) => { local = [...(v ?? [])]; reseeds.push(JSON.stringify(local)) }, [])

    // own emit: local mutates, then we write the matching model → echo, no reseed
    local = [1]
    model.value = [1]
    await nextTick()
    expect(reseeds).toEqual([]) // echo skipped

    // external change to a new value
    model.value = [2]
    await nextTick()
    expect(local).toEqual([2])

    // external change BACK to a previously-emitted value — a stale "last emitted" token would wrongly
    // skip this; comparing against the CURRENT snapshot reseeds correctly
    model.value = [1]
    await nextTick()
    expect(local).toEqual([1])
    expect(reseeds).toEqual(['[2]', '[1]'])
  })

  it('treats a null/undefined model as the supplied empty default for the comparison', async () => {
    const model = ref<number[] | null>([])
    let local: number[] = []
    let reseeded = false
    useEchoGuard(model, () => local, (v) => { local = [...(v ?? [])]; reseeded = true }, [])
    model.value = null // ?? [] === current [] → echo, no reseed
    await nextTick()
    expect(reseeded).toBe(false)
  })

  it('short-circuits the own-emit echo via reference equality, without serializing (e.g. a large block tree per keystroke)', async () => {
    const blocks = ref<{ id: number }[]>([{ id: 1 }])
    const model = ref<{ id: number }[]>([])
    let reseeded = false
    useEchoGuard(model, () => blocks.value, () => { reseeded = true })

    const spy = vi.spyOn(JSON, 'stringify')
    model.value = blocks.value // own emit: same reactive proxy on both sides of the comparison
    await nextTick()

    expect(reseeded).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
