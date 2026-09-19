# @michaelthielemann/kestrel-contracts
The standard contracts: `persistence@1`, `authn@1`, `authz@1`, `blobstore@1`, `events@1`, `content@1`,
`site@1`, `renderer@1`, `validate@1`, `revisions@1`, `migrations@1`, `insights@1`.
Each contract is one file plus one `*.contract.test.ts` suite every implementation must pass.
Every async method answers `Promise<Result<T, E>>` from `@michaelthielemann/kestrel/result`; the
error union of each contract is declared next to it (`PersistenceError`, `ContentError`, …) and
`errors.ts` re-exports the core error model the contract files build on. A `throw` is left for
wiring bugs only.
`testing/fakePersistence` is an in-memory `persistence@1` for tests of modules that need one;
`failNext(code)` makes its next call answer `Err`. It mirrors SQLite's own semantics so a module
behaves the same against both: a REAL renders as `%!.15g` (always a fractional digit, exponential
below 1e-4), `LIKE` folds case for ASCII letters only, and without a declared schema the column type
is inferred from the stored value. `testing/result` holds `expectOk` / `expectErr`
for the suites.
`links` is not a contract but a pure helper pair shared by the modules that read internal
references (`INTERNAL_REF`, `collectInternalRefs`).
Consumers may define their own contracts with `defineContract` from the core; the core treats
them exactly like these.
