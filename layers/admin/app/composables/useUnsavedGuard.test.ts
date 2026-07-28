import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the guards registered with vue-router so we can assert BOTH hooks are wired and exercise the
// predicate directly (no component/router runtime needed).
const { leaveGuards, updateGuards } = vi.hoisted(() => ({
  leaveGuards: [] as Array<() => unknown>,
  updateGuards: [] as Array<() => unknown>,
}))
vi.mock('vue-router', () => ({
  onBeforeRouteLeave: (g: () => unknown) => { leaveGuards.push(g) },
  onBeforeRouteUpdate: (g: () => unknown) => { updateGuards.push(g) },
}))

import { useUnsavedGuard } from './useUnsavedGuard'

beforeEach(() => {
  leaveGuards.length = 0
  updateGuards.length = 0
  vi.unstubAllGlobals()
})

const allGuards = () => [...leaveGuards, ...updateGuards]

describe('useUnsavedGuard', () => {
  it('registers BOTH a leave and an update guard — same-record param/query nav fires onBeforeRouteUpdate', () => {
    useUnsavedGuard(() => true, () => 'discard?')
    expect(leaveGuards).toHaveLength(1)
    expect(updateGuards).toHaveLength(1)
  })

  it('cancels navigation (returns false) when dirty and the user declines the confirm', () => {
    vi.stubGlobal('confirm', () => false)
    useUnsavedGuard(() => true, () => 'discard?')
    for (const g of allGuards()) expect(g()).toBe(false)
  })

  it('allows navigation when not dirty, without ever prompting', () => {
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    useUnsavedGuard(() => false, () => 'discard?')
    for (const g of allGuards()) expect(g()).toBeUndefined()
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('allows navigation when the user accepts the confirm', () => {
    vi.stubGlobal('confirm', () => true)
    useUnsavedGuard(() => true, () => 'discard?')
    for (const g of allGuards()) expect(g()).toBeUndefined()
  })

  it('skips the guard entirely when skip() is true (post-save / delete redirect)', () => {
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    useUnsavedGuard(() => true, () => 'discard?', () => true)
    for (const g of allGuards()) expect(g()).toBeUndefined()
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
