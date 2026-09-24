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
for the suites. `testing/fakeAuthn` is a minimal `authn@1` for the shared step-contract suite
(`authn.steps.contract.test`), which every `authn@1` implementation runs its five shared steps
(`login`, `identifyUser`, `requireUser`, `loadIdentity`, `logout`) against.
`links` is not a contract but a pure helper pair shared by the modules that read internal
references (`INTERNAL_REF`, `collectInternalRefs`).
`mediaType` is not a contract either: `mediaTypeEssence` accepts a declared content type only when
it is exactly one media type (RFC 9110 tokens, optional `;` parameters, no comma) and answers its
lower-cased `type/subtype`; `publicFormOf` answers the `Content-Type` and extension every module
publishes a stored file with — a type from `EXTENSION_BY_TYPE`, none of which a browser runs as a
document, or `application/octet-stream` and `bin` for anything else, including an SVG that did not
pass `sanitize.svg`.
`content-locale` is not a contract either: `satisfiesFilter`, `publishedLocale` and
`narrowListTranslations` implement one rule on top of `content@1` — a locale that fails a filter is
never a fallback source and never counted in `_translations` — for every module that builds a
public view of content (`site-default`'s `resolve`/`resolveLinks`, `delivery-static`'s
`delivery.publish`/`exportLlms`, `content-default`'s own `get`/`list` steps). `satisfiesFilter`
decides membership through `content.list` itself, so a `Condition` entry (`{ in: [...] }`,
`{ ne: ... }`, …) is evaluated with the store's own semantics — never reimplemented, and never
turns into a false negative or a thrown error at request time — including when `filter` names a
field the type does not declare, which is simply unserved rather than an error. Correctness costs
reads: `publishedLocale` decides every locale's filter membership fresh, on the store, and never
caches or reuses one call's result for another (`site-default`'s README states the count this comes
to for `resolve`).
Consumers may define their own contracts with `defineContract` from the core; the core treats
them exactly like these.
