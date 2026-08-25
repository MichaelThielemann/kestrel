// Indexed view over an Istanbul-shaped coverage report, for the audit detectors.
//
// Two questions only: which branch arms were never taken, and which functions never ran. Both are
// keyed by line so they can be joined to the graph, whose nodes carry a start line and no span.
import { readFileSync, statSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'

export function loadCoverage(root, file = 'reports/coverage/coverage-final.json') {
  const path = isAbsolute(file) ? file : join(root, file)
  let raw
  let generatedAt
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
    generatedAt = statSync(path).mtimeMs
  } catch {
    return null
  }

  const byFile = new Map()
  for (const entry of Object.values(raw)) {
    const rel = relative(root, entry.path)
    const missedBranchLines = new Set()
    let branchMissCount = 0
    for (const [key, arm] of Object.entries(entry.branchMap ?? {})) {
      const counts = entry.b?.[key] ?? []
      arm.locations?.forEach((location, index) => {
        if (counts[index] !== 0) return
        branchMissCount += 1
        const line = location.start?.line ?? arm.line
        if (line) missedBranchLines.add(line)
      })
    }
    const ranFunctionLines = new Set()
    for (const [key, fn] of Object.entries(entry.fnMap ?? {})) {
      if (!entry.f?.[key]) continue
      const line = fn.decl?.start?.line ?? fn.loc?.start?.line
      if (line) ranFunctionLines.add(line)
    }
    byFile.set(rel, { missedBranchLines, branchMissCount, ranFunctionLines })
  }

  const empty = { missedBranchLines: new Set(), branchMissCount: 0, ranFunctionLines: new Set() }
  return {
    generatedAt,
    files: [...byFile.keys()],
    has: (file) => byFile.has(file),
    missedBranchLines: (file) => (byFile.get(file) ?? empty).missedBranchLines,
    branchMissCount: (file) => (byFile.get(file) ?? empty).branchMissCount,
    ranFunctionLines: (file) => (byFile.get(file) ?? empty).ranFunctionLines,
  }
}
