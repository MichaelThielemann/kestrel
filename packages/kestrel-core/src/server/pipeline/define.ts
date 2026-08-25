import { isStandardOp, type PatchOp, type PipelineDef, type StepDef } from './types.js'

const ANCHORS = ['before', 'after', 'replace'] as const

/** @public */
export function definePipeline(def: PipelineDef): PipelineDef {
  const label = `pipeline "${def.name ?? '<unnamed>'}"`
  if (typeof def.name !== 'string' || def.name.trim() === '') {
    throw new Error('[kestrel] definePipeline requires a non-empty `name`')
  }
  if (def.op !== undefined && !isStandardOp(def.op)) {
    throw new Error(`[kestrel] ${label} targets op "${def.op}", which is not one of the standard operations`)
  }
  if (def.steps && def.patch) {
    throw new Error(`[kestrel] ${label} declares both \`steps\` and \`patch\` — a full list replaces what a patch would edit; pick one`)
  }
  if (!def.steps && !def.patch && !def.after) {
    throw new Error(`[kestrel] ${label} declares none of \`steps\`, \`patch\` or \`after\` — it would do nothing`)
  }

  if (def.steps) {
    const seen = new Set<string>()
    for (const step of def.steps) {
      assertStep(step, label)
      if (seen.has(step.name)) {
        throw new Error(`[kestrel] ${label} declares the step "${step.name}" twice — step names address patch anchors and must be unique`)
      }
      seen.add(step.name)
    }
  }

  for (const entry of def.patch ?? []) assertPatch(entry, label)

  for (const entry of def.after ?? []) {
    if (typeof entry?.critical !== 'boolean') {
      throw new Error(`[kestrel] ${label} has an \`after\` entry without an explicit \`critical\` flag`)
    }
    assertStep(entry.step, label)
  }

  return def
}

function assertStep(step: StepDef | undefined, label: string): void {
  if (!step || typeof step.name !== 'string' || step.name.trim() === '') {
    throw new Error(`[kestrel] ${label} has a step without a \`name\``)
  }
  if (typeof step.fn !== 'function') {
    throw new Error(`[kestrel] ${label} step "${step.name}" has no \`fn\``)
  }
  if (step.when !== undefined && typeof step.when !== 'function') {
    throw new Error(`[kestrel] ${label} step "${step.name}" has a non-callable \`when\``)
  }
}

function assertPatch(entry: PatchOp, label: string): void {
  const anchors = ANCHORS.filter((key) => typeof (entry as Record<string, unknown>)[key] === 'string')
  if (anchors.length !== 1) {
    throw new Error(`[kestrel] ${label} has a patch entry with ${anchors.length === 0 ? 'no' : 'more than one'} anchor — use exactly one of \`before\`, \`after\`, \`replace\``)
  }
  if ('unsafeReplace' in entry && entry.unsafeReplace && anchors[0] !== 'replace') {
    throw new Error(`[kestrel] ${label} sets \`unsafeReplace\` on a \`${anchors[0]}\` patch entry — it only applies to \`replace\``)
  }
  assertStep(entry.step, label)
}
