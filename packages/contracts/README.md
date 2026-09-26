# @michaelthielemann/kestrel-contracts
The standard contracts: `persistence@1`, `authn@1`, `authz@1`, `blobstore@1`, `events@1`, `content@1`,
`site@1`, `renderer@1`, `validate@1`, `revisions@1`, `migrations@1`, `insights@1`, `media@1`.
Each contract is one file plus one `*.contract.test.ts` suite every implementation must pass,
imported as `@michaelthielemann/kestrel-contracts/<name>.contract.test`. The package's own unit tests
are not part of it.
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
(`login`, `identifyUser`, `requireUser`, `loadIdentity`, `logout`) against. `testing/fakeMedia` is an
in-memory `media@1` for tests of a consumer: `add`, `addPending` and `markReady` (a file not ready
yet), `remove` (ends a file's readiness), `loseBytes`, the recorded `calls`, and a `beforeCall` hook
that can change the store between a consumer's calls.
`helpers/persistence.owned` is not a contract: `ownedPersistence(db, owner, collections)` is a
`persistence@1` view that reaches only the named collections and throws a wiring error naming
`owner` for any other, before the store is asked — for a module whose storage must stay its own.
`helpers/persistence`'s `fieldDefinition`, `helpers/renderer`'s `renderFailed` and
`helpers/migrations`'s `migrationFailed` normalize a schema field and build a contract's own
`KestrelError` respectively — runtime functions next to a frozen contract, not part of it.
`links` declares the frozen `content@1` underpinning shared by the modules that read internal
references: `INTERNAL_REF`, `InternalRef` and `LinkTarget`. `helpers/links`'s `collectInternalRefs`
walks a value for every `INTERNAL_REF` match, the runtime counterpart of that same declaration.
`helpers/mediaType` is not a contract either: `parseMediaType` accepts a declared content type only when it
is exactly one media type (RFC 9110 tokens, optional `;` parameters, no comma); `mediaTypeEssence`
answers its lower-cased `type/subtype`, and `canonicalMediaType` the form it is stored in — that
essence, plus the charset of a `text/*` type when it is a token. `publicFormOf` answers the
`Content-Type` and extension every module publishes a stored type with — a type from
`EXTENSION_BY_TYPE`, none of which a browser runs as a document, or `application/octet-stream` and
`bin` for anything else, including an SVG that did not pass `sanitize.svg`. The list only ever grows,
since a published name keeps its extension. `mediaTypeMatches` and `mediaTypeAllowed` are the
`allowedTypes`/`deniedTypes` pattern rule: `*` and `*/*` match every type, `type/*` a top-level type,
`type/*+suffix` every subtype of a top-level type that ends in `+suffix` (with `*` as the type, of
every top-level type), any other pattern one type, with case and parameters ignored on both sides.
`media@1`'s `MediaFilter` uses the same rule.
`helpers/content-locale` is not a contract either: `satisfiesFilter`, `publishedLocale` and
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

## Frozen contracts vs. helpers
Frozen means a `defineContract` interface and its own types — they do not change once released, and a
change request goes to a human, never straight into the file. Concretely, this package's frozen
surface is: every contract listed above; `query`'s shared vocabulary (`Condition`, `Filter`,
`FindOptions`, `Page`); `links`'s `content@1` underpinning (`INTERNAL_REF`, `InternalRef`,
`LinkTarget`); `verifiedUser`'s `Context` augmentation; `authn.steps`'s step-set declaration
(`AUTHN_STEPS`); `events.steps`'s step-set declaration and payload/status shapes
(`EVENT_DELIVERY_STEPS`, `EventIdentity`, `EventEnvelope`, `DeliveryStatus`, `DELIVERY_STATUS_SCHEMA`,
`RELAY_SCHEMA`, `RelayEntry`, `RelayReport`); and `stepSet`'s `StepSet` type, the shape of every
step-set declaration above, frozen with them though it declares no data of its own.

Everything under `@michaelthielemann/kestrel-contracts/helpers/<name>` is a runtime helper, not a
contract: it may gain new exports within a major (additive only), but never breaks one. The helpers
are `helpers/stepSet` (`defineStepSet`, `stepSets` — the builder functions behind a step set, as
opposed to the frozen `StepSet` type they return), `helpers/steps` (`STEP_SETS`, the declared step
sets a reader consults for the portability marking), `helpers/events.envelope` (`eventEnvelope`,
`parseEmitSpec`, `withEventIdentity`, `relaySummary`, `mergeRelayReport` — runtime logic built on the
frozen shapes in `events.steps`), `helpers/persistence.owned` (`ownedPersistence`),
`helpers/content-locale` (`satisfiesFilter`, `publishedLocale`, `narrowListTranslations`),
`helpers/content-schema` (`documentSchema`, `fieldSchema`), `helpers/links` (`collectInternalRefs`),
`helpers/mediaType` (`parseMediaType`, `mediaTypeEssence`, `canonicalMediaType`, `publicFormOf`,
`mediaTypeMatches`, `mediaTypeAllowed`, `EXTENSION_BY_TYPE`, `NEUTRAL_TYPE`, `NEUTRAL_EXTENSION`),
`helpers/persistence` (`fieldDefinition`), `helpers/renderer` (`renderFailed`) and
`helpers/migrations` (`migrationFailed`).

`errors` re-exports `@michaelthielemann/kestrel/errors` and `@michaelthielemann/kestrel/result` and
stays at its top-level path. `testing/*` (`fakePersistence`, `fakeAuthn`, `fakeMedia`, `result`) are
test doubles and assertion helpers for the contract suites — neither frozen nor a `helpers/*` runtime
helper.
