#!/usr/bin/env node
// Port-graph extraction (experiment): for every exported function in packages/kestrel-core/src whose
// return type resolves to `Effect.Effect<A, E, R>`, the R (requirements) channel becomes that function's
// port list. Every `Layer.succeed`/`Layer.effect`/`Layer.scoped` call becomes an adapter binding from the
// layer's containing function to the port it provides. Nodes reuse graphify-out/graph.json's id scheme so
// the two graphs join; a node not already present there is synthesized with the same scheme and flagged.
//
// The R channel alone cannot answer "does persist always follow validate" — this codebase passes the
// database as a plain function parameter, not a Context.Tag requirement, so R is `never` on every step.
// To make that invariant askable as a graph query at all, this script also extracts each `definePipeline`
// call's literal `steps: [...]` array (resolving each step-factory call to the runtime step name registered
// via `syncStep(name, ...)`) into an ordered step chain, and exposes `stepOrderRespectsInvariant` for
// querying it.
import ts from 'typescript'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const corePkg = join(root, 'packages/kestrel-core')
const graphOutDir = join(root, 'graphify-out')

// --- graph id scheme (mirrors graphify's own slugging, see graphify-out/graph.json) ---

function slugFile(relFile) {
  return relFile.replace(/\.[^/.]+$/, '').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
}

function slugSymbol(name) {
  return name.replace(/\(\)$/, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function loadExistingGraph() {
  const graphPath = join(graphOutDir, 'graph.json')
  if (!existsSync(graphPath)) return { nodes: [], byFileAndLabel: new Map() }
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'))
  const byFileAndLabel = new Map()
  for (const n of graph.nodes) byFileAndLabel.set(`${n.source_file}::${n.label}`, n)
  return { nodes: graph.nodes, byFileAndLabel }
}

/** Reuses the existing graph's node id for (relFile, name) when present; otherwise synthesizes one with
 *  the same scheme and marks it so a future graphify run can be checked against it. */
function nodeIdFor(existing, relFile, name) {
  const found = existing.byFileAndLabel.get(`${relFile}::${name}()`)
  if (found) return { id: found.id, synthesized: false }
  return { id: `${slugFile(relFile)}_${slugSymbol(name)}`, synthesized: true }
}

function loadProgram() {
  const tsconfigPath = join(corePkg, 'tsconfig.json')
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, corePkg)
  const fileNames = parsed.fileNames.filter((f) => !/\.test\.ts$/.test(f) && !f.includes(`${corePkg}/test/`))
  const program = ts.createProgram(fileNames, { ...parsed.options, noEmit: true })
  return { program, fileNames }
}

function hasExportModifier(node) {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0
}

function isEffectReturnType(type) {
  const target = type.aliasSymbol ?? type.target?.symbol ?? type.symbol
  return target?.name === 'Effect' && !!(type).typeArguments
}

/** Flattens a union of `Context.Tag`-shaped types (or a bare one) into distinct display names, dropping
 *  `never` (the honest "no requirements" answer, not an omission). */
function portNamesFromRType(checker, rType) {
  if (!rType) return []
  const parts = rType.isUnion?.() ? rType.types : [rType]
  const names = new Set()
  for (const t of parts) {
    const text = checker.typeToString(t)
    if (text === 'never' || text === 'unknown') continue
    names.add(text)
  }
  return [...names]
}

/** Visits every exported function-like declaration (function declarations and `export const f = (...) =>`)
 *  in a source file, at the top level and one level of nesting (namespaces are not used in this codebase). */
function* exportedFunctions(sf) {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && hasExportModifier(stmt) && stmt.name) {
      yield { name: stmt.name.text, decl: stmt }
    } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          yield { name: d.name.text, decl: d.initializer }
        }
      }
    }
  }
}

function extractFunctionPorts(program, existing) {
  const checker = program.getTypeChecker()
  const functions = []
  let scanned = 0
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(corePkg) || sf.fileName.includes('/node_modules/')) continue
    const relFile = relative(root, sf.fileName)
    for (const { name, decl } of exportedFunctions(sf)) {
      scanned++
      const sig = checker.getSignatureFromDeclaration(decl)
      if (!sig) continue
      const returnType = checker.getReturnTypeOfSignature(sig)
      if (!isEffectReturnType(returnType)) continue
      const typeArgs = checker.getTypeArguments(returnType)
      const rType = typeArgs[2]
      const ports = portNamesFromRType(checker, rType)
      const { id, synthesized } = nodeIdFor(existing, relFile, name)
      functions.push({ id, name, file: relFile, ports, synthesized })
    }
  }
  return { functions, scanned }
}

function containingFunctionName(node) {
  let cur = node.parent
  while (cur) {
    if ((ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur)) ) {
      if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text
      if (ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) return cur.parent.name.text
    }
    cur = cur.parent
  }
  return null
}

/** Resolves a `Context.GenericTag<X>(...)` (or `Context.Tag<X, ...>`) expression, following one level of
 *  identifier indirection, to the service type name `X`. */
function resolveTagTypeName(checker, expr) {
  let target = expr
  if (ts.isIdentifier(expr)) {
    const sym = checker.getSymbolAtLocation(expr)
    const decl = sym?.valueDeclaration
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer) target = decl.initializer
  }
  if (ts.isCallExpression(target) && target.typeArguments?.length) {
    return target.typeArguments[0].getText()
  }
  return null
}

const LAYER_CONSTRUCTORS = new Set(['succeed', 'effect', 'scoped', 'sync'])

function extractLayerBindings(program, existing) {
  const checker = program.getTypeChecker()
  const bindings = []
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(corePkg) || sf.fileName.includes('/node_modules/')) continue
    const relFile = relative(root, sf.fileName)
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'Layer'
        && LAYER_CONSTRUCTORS.has(node.expression.name.text)
        && node.arguments.length > 0
      ) {
        const tagName = resolveTagTypeName(checker, node.arguments[0])
        if (tagName) {
          const fnName = containingFunctionName(node) ?? '<module scope>'
          const { id, synthesized } = nodeIdFor(existing, relFile, fnName)
          bindings.push({
            layerFnId: id,
            layerFnName: fnName,
            file: relFile,
            line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            constructor: node.expression.name.text,
            port: tagName,
            synthesized,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return bindings
}

// --- Pipeline step-order extraction (makes the validate-before-persist invariant askable as a graph query) ---

/** Maps every step-factory function name (e.g. `validateCreateStep`) to the runtime step name it registers
 *  via `syncStep('<name>', ...)` / `asyncStep('<name>', ...)`. A factory with more than one such call inside
 *  keeps only the first — every factory in this codebase registers exactly one step. */
function buildStepNameMap(program) {
  const map = new Map()
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.includes('/pipeline/steps/') || sf.fileName.includes('/node_modules/')) continue
    for (const { name, decl } of exportedFunctions(sf)) {
      let stepName = null
      const visit = (node) => {
        if (stepName) return
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && (node.expression.text === 'syncStep' || node.expression.text === 'asyncStep')
          && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
        ) {
          stepName = node.arguments[0].text
          return
        }
        ts.forEachChild(node, visit)
      }
      visit(decl)
      if (stepName) map.set(name, stepName)
    }
  }
  return map
}

function extractPipelineStepChains(program) {
  const stepNameMap = buildStepNameMap(program)
  const pipelines = []
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(corePkg) || sf.fileName.includes('/node_modules/')) continue
    const relFile = relative(root, sf.fileName)
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'definePipeline'
        && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const obj = node.arguments[0]
        const nameProp = obj.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'name')
        const stepsProp = obj.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'steps')
        if (nameProp && ts.isStringLiteral(nameProp.initializer) && stepsProp && ts.isArrayLiteralExpression(stepsProp.initializer)) {
          const steps = []
          for (const el of stepsProp.initializer.elements) {
            // `steps: deleteSteps` (an identifier referring to a separately declared array) is skipped —
            // rollback/duplicate/delete are not in VALIDATING_WRITE_OPS, so the invariant query never needs it.
            if (ts.isCallExpression(el) && ts.isIdentifier(el.expression)) {
              const factoryName = el.expression.text
              steps.push(stepNameMap.get(factoryName) ?? factoryName)
            } else if (ts.isCallExpression(el) && ts.isPropertyAccessExpression(el.expression)) {
              steps.push(el.expression.name.text)
            }
          }
          pipelines.push({ name: nameProp.initializer.text, file: relFile, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, steps })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return pipelines
}

/** The validate-before-persist invariant, as a pure query over an ordered step-name chain: `validate` must occur, `persist`
 *  must occur, and `validate` must precede `persist`. Mirrors test/architecture/pipeline-invariants.test.ts'
 *  registry-based check, but over the statically extracted `definePipeline` step array instead of a
 *  runtime-composed `PipelineDescriptor`. */
export function stepOrderRespectsInvariant(stepNames) {
  const validateAt = stepNames.indexOf('validate')
  const persistAt = stepNames.indexOf('persist')
  if (validateAt < 0 || persistAt < 0) return false
  return validateAt < persistAt
}

export const VALIDATING_WRITE_OPS = new Set(['createOne', 'createMany', 'updateOne', 'updateMany'])

export function extractPortGraph() {
  const { program } = loadProgram()
  const existing = loadExistingGraph()
  const { functions, scanned } = extractFunctionPorts(program, existing)
  const bindings = extractLayerBindings(program, existing)
  const pipelines = extractPipelineStepChains(program)
  return { functions, scanned, bindings, pipelines }
}

function buildEmittedGraph({ functions, bindings, pipelines }) {
  const nodes = []
  const links = []
  const seenNodes = new Set()
  const addNode = (node) => {
    if (seenNodes.has(node.id)) return
    seenNodes.add(node.id)
    nodes.push(node)
  }

  for (const fn of functions) {
    addNode({ id: fn.id, label: `${fn.name}()`, kind: 'function', source_file: fn.file, synthesized: fn.synthesized })
    for (const port of fn.ports) {
      const portId = `port_${slugSymbol(port)}`
      addNode({ id: portId, label: port, kind: 'port' })
      links.push({ relation: 'requires', source: fn.id, target: portId, source_file: fn.file })
    }
  }

  for (const b of bindings) {
    addNode({ id: b.layerFnId, label: `${b.layerFnName}()`, kind: 'function', source_file: b.file, synthesized: b.synthesized })
    const portId = `port_${slugSymbol(b.port)}`
    addNode({ id: portId, label: b.port, kind: 'port' })
    links.push({ relation: 'provides', source: b.layerFnId, target: portId, source_file: b.file, source_location: `L${b.line}`, layer_constructor: b.constructor })
  }

  for (const [i, p] of pipelines.entries()) {
    const pipelineId = `pipeline_${slugFile(p.file)}_${slugSymbol(p.name)}_${i}`
    addNode({ id: pipelineId, label: `${p.name} (pipeline)`, kind: 'pipeline', source_file: p.file, source_location: `L${p.line}` })
    p.steps.forEach((stepName, order) => {
      const stepId = `pipeline_step_${slugSymbol(stepName)}`
      addNode({ id: stepId, label: stepName, kind: 'pipeline_step' })
      links.push({ relation: 'pipeline_step', source: pipelineId, target: stepId, order, source_file: p.file })
    })
  }

  return { nodes, links }
}

function main() {
  const { functions, scanned, bindings, pipelines } = extractPortGraph()
  const nonEmpty = functions.filter((f) => f.ports.length > 0)
  const totalPorts = new Set(functions.flatMap((f) => f.ports)).size

  const emitted = buildEmittedGraph({ functions, bindings, pipelines })
  const reportDir = join(root, 'reports/graph')
  mkdirSync(reportDir, { recursive: true })
  const outPath = join(reportDir, 'port-graph.json')
  writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), nodes: emitted.nodes, links: emitted.links }, null, 2))

  console.log(`port-graph: scanned ${scanned} exported functions in packages/kestrel-core/src`)
  console.log(`port-graph: ${functions.length} have an Effect.Effect<A, E, R> return type`)
  console.log(`port-graph: ${nonEmpty.length} have a non-empty (non-never) R channel; ${totalPorts} distinct ports found`)
  console.log(`port-graph: ${bindings.length} Layer composition(s) -> adapter binding(s) found`)
  console.log(`port-graph: ${pipelines.length} definePipeline() call(s) with a literal steps array extracted`)
  console.log(`port-graph: wrote ${emitted.nodes.length} nodes, ${emitted.links.length} links to ${relative(root, outPath)}`)

  if (nonEmpty.length === 0) {
    console.log('port-graph: honest finding — every scanned function has R = never (DB/services are plain')
    console.log('port-graph: parameters here, not Context.Tag requirements), so the R-channel port list is')
    console.log('port-graph: empty by construction. The pipeline_step chains above make the validate-before-persist')
    console.log('port-graph: invariant askable as a graph query at all; see test/architecture/port-graph-cross-check.test.ts.')
  }

  for (const p of pipelines) {
    if (!VALIDATING_WRITE_OPS.has(p.name)) continue
    const ok = stepOrderRespectsInvariant(p.steps)
    console.log(`port-graph: pipeline "${p.name}" (${p.file}:L${p.line}) validate-before-persist = ${ok}`)
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) main()
