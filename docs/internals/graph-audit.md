# The graph-grounded code audit

Three stages, run in order. The graph targets, the test suite proves, an agent judges only what was
proven.

1. **Coverage** — `pnpm test:coverage`
2. **Target** — `pnpm graph:audit --scope <path> [--top N]`, then `pnpm mutation:scope --scope <name> [--dry-run]`
3. **Judge** — the `graph-audit-review` skill, then `node scripts/graph-audit-record.mjs`

## Stage 1: coverage

`pnpm test:coverage` runs `scripts/coverage-all.mjs`. It runs the root Vitest suite plus each of the
per-package suites under `packages/*/vitest.config.ts`, instrumenting each with the V8 coverage
provider, then merges the parts into `reports/coverage/coverage-final.json`.

The merge is additive per file when two parts' instrumentation maps agree (same statements, functions,
branches); when they disagree — the same file compiled two different ways under two configs — the entry
with more executed functions wins and the conflict is logged rather than silently summed.

The script exits non-zero if any suite failed, but writes the merged artifact regardless. **The
artifact's existence is the success signal the later stages check, not the exit code** — two
architecture tests currently fail under instrumentation for timing reasons unrelated to coverage, and
that must not block the merge. `reports/` is gitignored; nothing from this stage is committed.

## Stage 2: target

### `node scripts/graph-audit.mjs [--scope <path>] [--top N] [--detector <name>] [--all] [--out <dir>] [--graph <dir>] [--ledger <path>] [--no-gate]`

(equivalently `pnpm graph:audit`). Loads `graphify-out/graph.json`, joins it with
`reports/coverage/coverage-final.json` when present, and runs the detector set over it: `weak-guard`,
`sibling-parity`, `call-order`, `position-invariant`, `zone-leak`, `import-cycle`, `layer-cycle`,
`twin-modules`, `test-gap`, `orphan`. Three of these (`test-gap`, `orphan`, `weak-guard`) need the
coverage artifact and are reported as **skipped**, not silently degraded, when it is missing.

Writes `docs/parity/candidates.md` and `candidates.json` (every candidate found, minus anything already
in `docs/parity/ledger.md`) and `agenda.json` (the batching decision for stage 3 — detector, candidate
ids, files, and the model/effort tier to adjudicate at). All three are gitignored; they regenerate on
every run.

Two detectors are recorded in the report but never placed on the agenda, for opposite reasons:

- **`orphan`** — its criterion is "no inbound edge found", which selects for the AST extractor's own
  blind spots (same-file calls nested inside object-literal properties, Nuxt auto-imported composables,
  cross-package public exports) rather than for dead code. A sample of roughly 20 of these candidates
  found none confidently dead.
- **`weak-guard`** — it is a target list for stage 2's mutation step, not a reading agenda. Its verdict
  comes from surviving mutants, not from an agent reading the code.

`test-gap` is capped in the agenda at its 40 highest-missed-branch candidates, ranked by evidence count;
the rest stay visible in `candidates.md` but are not batched for adjudication.

`layer-cycle` and `import-cycle` are both active, but see different things. The graph holds zero
extracted import edges between two different `packages/*` — the extractor discards static bare
specifiers and does not resolve workspace path aliases — so a clean `layer-cycle` result covers only the
`layers/*`/`extensions/*` stack, not package-to-package cycles. `import-cycle` is unaffected: it works at
file level, so a cycle inside one package needs no cross-package edge at all.

### `node scripts/mutation-target.mjs --scope <name> [--dry-run]`

(equivalently `pnpm mutation:scope`). Reads the `weak-guard` candidates out of `docs/parity/candidates.json`,
generates a Stryker config scoped to exactly those target files, and picks the test files to run by
following graph edges from test files to the target nodes (falling back to the full suite, with a
warning, if the graph has no such edge). `--dry-run` writes the Stryker config without invoking Stryker.

A real run mutates the target files, runs the scoped test suite against each mutant, and writes
`docs/parity/mutants.json`: every mutant that survived or had no coverage, each attributed to "the last
callable declared above it" (graph nodes carry a start line but no span) — the mutant's own line travels
with the record regardless, so a wrong attribution never hides the citation. A surviving mutant is the
one piece of evidence in this rail that needs no further reading to trust: it demonstrates the line can
change without any test noticing.

## Stage 3: judge

The `graph-audit-review` skill reads `docs/parity/agenda.json` and dispatches one subagent per batch, at
the model and effort the agenda assigned, to adjudicate `candidates.json`. Every proposed defect goes
through a second, adversarial agent whose job is to refute it. When `docs/parity/mutants.json` exists,
the skill also runs its mutant mode: one batch per file's surviving mutants, judged into `defect`,
`missing-test` (only when a new test is shown to pass against HEAD and fail against the mutation), or
`justified`.

`node scripts/graph-audit-record.mjs` then validates every verdict id against `candidates.json`,
appends justified verdicts to `docs/parity/ledger.md`, and writes `docs/parity/findings.md`. Both files
are tracked and commit; everything upstream of them regenerates and does not.

## Why `graphify-out/` is read-only

`graphify-out/` belongs to a third-party tool (`graphify`) that rewrites and rotates it on its own
schedule. Nothing in this rail writes into it — the detectors only read `graph.json`, and a stale or
malformed graph is refused rather than patched around.

## The two gates

Both live in `assertGraphUsable()` in `scripts/lib/graph-model.mjs` and both abort rather than degrade:

- **The schema gate** checks that graph nodes carry `id`, `label`, `source_file`, `source_location` and
  that edges carry `source`, `target`, `relation`, `confidence`. If graphify changes its output shape,
  the error names the specific missing field rather than letting the detectors read absent data as a
  negative finding.
- **The freshness gate** compares the graph's own `built_at_commit` against `git rev-parse HEAD` and
  checks the working tree is clean. A dirty tree or a graph built at a different commit means citations
  would point at lines that have since moved, so the run refuses with the commit mismatch (or "working
  tree is dirty") rather than producing findings against stale line numbers.

Pass `--no-gate` to skip both — only for developing the detectors themselves against a graph you know is
stale; never for a run whose output will be adjudicated.

## The SQL prerequisite

The AST extractor graphify runs on needs `pip install "graphifyy[sql]"` to parse `.sql` files at all.
Without it, all 19 `.sql` files in this repository (migrations and hand-written schema) contribute zero
nodes to the graph, and the whole migration and schema layer is invisible to every detector — not
reported as a limit, simply absent as if it did not exist. Installing the extra is a one-time local setup
step, not a code change.

## What the graph cannot tell you

Copied verbatim from `LIMITS` in `scripts/lib/graph-model.mjs`, and repeated at the top of every
`candidates.md` this rail produces:

- Only repo-defined symbols are nodes. Imported library symbols (`createError`, `eq`, zod, drizzle) are absent, so guards and throws built from them are invisible.
- Member calls produce no edge: `c.insert.safeParse(body)` and `db.insert(t).values(v).run()` do not appear. **DB writes and schema validation are therefore not in the graph** — never conclude a path does not write or does not validate.
- Edges carry the call-site line, which is textual order, not execution order. Conditions (`if (before) …`), early returns, try/catch, loops and `await` are not represented; a conditional call looks identical to an unconditional one.
- There is no data flow. Which variable a call receives, whether its result is used, and whether a payload was mutated in between are all unknown.
- `defineEventHandler` default exports get no callable node, so API routes, middleware and plugins contribute import edges only — the whole HTTP entry layer has no call order.
- Nodes carry a start line only, never a span.
- `indirect_call` edges are inferred (confidence 0.5) and say nothing about when the callback runs.
- Calls nested inside object-literal properties are missed even within one file, so a helper can look unreferenced while having many call sites.
- Two same-named local functions in different components can be conflated into one node, which produces edges that do not exist.
- Imports between two different `packages/*` may be entirely absent: the extractor discards static bare specifiers and does not resolve workspace path aliases. A zero cross-package edge count means package-level cycles cannot be checked — it says nothing about the `layers/*`/`extensions/*` stack, which resolves normally.

A candidate this rail produces is a place to look, never a defect claim, and a clean detector result
means "not observed", never "does not happen" — every limit above is a way that distinction can be lost
by a reader in a hurry.
