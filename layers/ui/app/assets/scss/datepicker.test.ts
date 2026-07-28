import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { compileString } from 'sass'

const dir = fileURLToPath(new URL('.', import.meta.url))

// The date pickers only ever apply the shared mixin, so compile it the way the components do.
const css = compileString("@use 'datepicker' as *;\n@include ui-datepicker;", { loadPaths: [dir] }).css

type Rule = { selector: string, body: string }

const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))

/**
 * Rules that apply to a segment focused via the keyboard — the element matches both `:focus` and
 * `:focus-visible`, so a `:not(:focus-visible)` qualifier excludes it.
 */
function keyboardFocusRules(base: string): Rule[] {
  return rules.filter((r) =>
    r.selector.split(',').some((sel) => {
      const s = sel.trim()
      if (!s.startsWith(base)) return false
      const rest = s.slice(base.length)
      return /^(:focus(-visible)?)*$/.test(rest)
    }),
  )
}

/** Declarations of equal specificity, so the last one in source order wins. */
function winning(prop: string, rulesInOrder: Rule[]): string | undefined {
  let value: string | undefined
  for (const r of rulesInOrder) {
    for (const m of r.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:([^;]+)`, 'g'))) value = m[1]!.trim()
  }
  return value
}

describe('datepicker styles', () => {
  it('keeps the focus ring visible on a keyboard-focused date segment', () => {
    const applied = keyboardFocusRules('.ui-datepicker__segment')
    expect(applied.length).toBeGreaterThan(0)
    expect(winning('outline', applied)).toBe('2px solid var(--color-focus)')
  })

  it('still fills the focused segment so the active part is identifiable', () => {
    expect(winning('background', keyboardFocusRules('.ui-datepicker__segment'))).toBe('var(--color-active)')
  })
})
