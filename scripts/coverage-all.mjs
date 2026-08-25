import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VITEST_BIN = path.join(ROOT, 'node_modules/.bin/vitest')
const PARTS_DIR = path.join(ROOT, 'reports/coverage/.parts')
const OUT_DIR = path.join(ROOT, 'reports/coverage')

function sameKeys(a, b) {
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  const setB = new Set(kb)
  return ka.every((k) => setB.has(k))
}

function mapsAgree(a, b) {
  return sameKeys(a.statementMap, b.statementMap) && sameKeys(a.fnMap, b.fnMap) && sameKeys(a.branchMap, b.branchMap)
}

function countExecutedFunctions(entry) {
  return Object.values(entry.f).filter((n) => n > 0).length
}

function cloneEntry(entry) {
  return structuredClone(entry)
}

function sumCounters(a, b) {
  const out = {}
  for (const k of Object.keys(a)) out[k] = a[k] + (b[k] ?? 0)
  return out
}

function sumBranches(a, b) {
  const out = {}
  for (const k of Object.keys(a)) {
    const branchA = a[k]
    const branchB = b[k] ?? []
    out[k] = branchA.map((count, i) => count + (branchB[i] ?? 0))
  }
  return out
}

// Istanbul JSON is keyed by absolute file path; the same path can show up in several parts
// (a package run and the root run both touching a shared file). When their instrumentation
// maps agree, counters are additive. When they disagree, the maps describe different
// transforms of the file — summing them would misattribute counts to the wrong statements/
// functions, so the richer entry wins outright and the conflict is reported instead of hidden.
export function mergeCoverage(parts, conflicts = []) {
  const merged = {}
  for (const part of parts) {
    for (const [filePath, entry] of Object.entries(part)) {
      const existing = merged[filePath]
      if (!existing) {
        merged[filePath] = cloneEntry(entry)
        continue
      }
      if (mapsAgree(existing, entry)) {
        merged[filePath] = {
          ...existing,
          s: sumCounters(existing.s, entry.s),
          f: sumCounters(existing.f, entry.f),
          b: sumBranches(existing.b, entry.b),
        }
      } else {
        if (countExecutedFunctions(entry) > countExecutedFunctions(existing)) {
          merged[filePath] = cloneEntry(entry)
        }
        conflicts.push(filePath)
      }
    }
  }
  return merged
}

function readCoverage(dir) {
  const file = path.join(dir, 'coverage-final.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function countFiles(coverage) {
  return coverage ? Object.keys(coverage).length : 0
}

function countFunctionsTotal(coverage) {
  if (!coverage) return 0
  let total = 0
  for (const entry of Object.values(coverage)) total += countExecutedFunctions(entry)
  return total
}

function discoverPackageSuites() {
  const packagesDir = path.join(ROOT, 'packages')
  if (!fs.existsSync(packagesDir)) return []
  return fs
    .readdirSync(packagesDir)
    .filter((name) => fs.existsSync(path.join(packagesDir, name, 'vitest.config.ts')))
    .sort()
    .map((name) => ({ name, cwd: path.join(packagesDir, name) }))
}

function runSuite(name, cwd) {
  const reportsDirectory = path.join(PARTS_DIR, name)
  fs.mkdirSync(reportsDirectory, { recursive: true })
  const args = [
    'run',
    '--coverage.enabled',
    '--coverage.provider=v8',
    '--coverage.reporter=json',
    `--coverage.reportsDirectory=${reportsDirectory}`,
    '--coverage.reportOnFailure=true',
  ]
  console.log(`\n=== ${name} (${path.relative(ROOT, cwd) || '.'}) ===`)
  const result = spawnSync(VITEST_BIN, args, { cwd, stdio: 'inherit' })
  const passed = result.status === 0
  const coverage = readCoverage(reportsDirectory)
  return { name, passed, coverage }
}

export function main() {
  fs.rmSync(PARTS_DIR, { recursive: true, force: true })
  fs.mkdirSync(PARTS_DIR, { recursive: true })

  const suites = [{ name: 'root', cwd: ROOT }, ...discoverPackageSuites()]
  const results = suites.map(({ name, cwd }) => runSuite(name, cwd))

  const conflicts = []
  const merged = mergeCoverage(
    results.map((r) => r.coverage).filter(Boolean),
    conflicts,
  )

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, 'coverage-final.json'), JSON.stringify(merged))

  console.log('\n=== coverage-all summary ===')
  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL'
    console.log(
      `${r.name.padEnd(24)} ${status}  files=${countFiles(r.coverage)}  functionsExecuted=${countFunctionsTotal(r.coverage)}`,
    )
  }

  if (conflicts.length > 0) {
    console.log(`\n${conflicts.length} merge conflict(s) (kept the entry with more executed functions):`)
    for (const filePath of conflicts) console.log(`  ${filePath}`)
  } else {
    console.log('\nno merge conflicts')
  }

  console.log(
    `\nmerged: files=${Object.keys(merged).length} functionsExecuted=${countFunctionsTotal(merged)} -> ${path.join(OUT_DIR, 'coverage-final.json')}`,
  )

  const anyFailed = results.some((r) => !r.passed)
  process.exitCode = anyFailed ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) main()
