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
`helpers/shape-migrations` runs a module's storage-shape migrations. A module describes its storage
as a `ModuleStorage`: its name, the shape `version` it writes, the oldest stored version it
converts (`convertsFrom`), the modules it depends on, and its `ShapeMigration`s. A migration has an
id `<package>:<name>`, the release it was `introducedIn`, a `kind` (`auto`, `ask`, `cleanup`),
whether it writes blobs, and `detect` (old form present?), `plan` (counts without writing), `apply`
(chunked, each item idempotent, new keys before rows switch, never deletes or overwrites an
authoritative row or blob) and an optional `verify` (default: `detect` finds nothing).
`runShapeMigrations` runs them in dependency order and by `introducedIn`, cleanups last, and writes
the module's row in `kestrel_storage_versions` only after every pending migration has been verified;
a rerun after an abort continues, a second run writes nothing. The row lists the migrations that ran
or found nothing, and a migration it lists never runs again. A run applies the kinds in `kinds`
(default `auto` and `ask`): a cleanup runs only in a run that names `cleanup`, also after the row
reached the release's version, and a pending cleanup does not hold the row back. An `ask` migration
runs only with an answer to each of its questions in `answers`. With `apply: false` it only detects and
plans and writes no version row unless `recordWhenCurrent` is set; `detect` and `plan` still prepare
the collections they read, which adds the release's new fields, so a plan of data an older release
still writes runs on a copy; `plan: false` skips `plan`. The `RunReport` lists each module
(`ModuleRun`: stored and release version, state) and each migration (`MigrationRun`: what `detect`
found, the `plan`, the `outcome`); a pending migration says why it was not applied in `blocked`
(`cleanup` and `not-selected` for a kind the run did not select, `plan-only`, `earlier-pending` for an
earlier pending migration of the module, `dependency-pending` for an unfinished module it depends on,
`blob-writes`, `needs-answer`). Data newer than the module's version, or
older than it converts, is left alone and reported (`update through <major>.x first`). Blobs are
reached through an injected `BlobOps` (`copy`, `head`); `blobOpsOf(blobstore)` builds one from any
`blobstore@1` by reading and writing the bytes, a runner with server-side copies passes its own.
`guardStorage` is the start-up check behind a module's `storageMigrations` setting: `check` refuses
data in an old form with `STORAGE_REFUSED`, naming the migrations and the command that runs them;
`apply` also runs the migrations that write no blobs. A migration that writes blobs, an `ask`
migration with a question and a cleanup never run at start-up; a pending cleanup is no reason to
refuse. The guard plans no migration, so a refusal costs only `detect`.
`helpers/session` is what an authn module shares with the others for browser sessions:
`requestToken` reads a request's bearer token or session cookie (`__Host-kestrel_token`, or the name
`sessionCookieName(secure)` gives) and says which it was,
`sessionCookie`/`clearedSessionCookie` build the `set-cookie` values (`HttpOnly`, `SameSite=Strict`,
`Path=/`, `Max-Age`, `Secure` unless turned off), and `crossOriginRefusal` answers why a
state-changing HTTP request authenticated by the cookie may not act — it must show
`Sec-Fetch-Site: same-origin` or an `Origin` matching its `Host`.
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
`sniffMediaType` names the type a file's leading bytes identify (PNG, JPEG, GIF, WebP, AVIF, HEIC/HEIF,
TIFF, BMP, ICO, JPEG XL, PDF, SVG, other XML, HTML) or `null`; `verifiedMediaType` answers the type an
upload is treated as — the identified type when a declared image type or PDF has bytes of another
type, the declared value otherwise — and `contentMatchesMediaType` whether the bytes are the declared
type.
`helpers/content-locale` is not a contract either: `satisfiesFilter`, `publishedLocale` and
`narrowListTranslations` implement one rule on top of `content@1` — a locale that fails a filter is
never a fallback source and never counted in `_translations` — for every module that builds a
public view of content (`site-default`'s `resolve`/`resolveLinks`, `delivery-static`'s
`delivery.publish` and index exports, `content-default`'s own `get`/`list` steps). `satisfiesFilter`
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
`LinkTarget`); `verifiedUser`'s and `knownDevice`'s `Context` augmentations; `authn.steps`'s step-set declaration
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
`helpers/content-schema` (`documentSchema`, `fieldSchema`), `helpers/json-schema` (`resolveSchema`,
`isSchemaNode`, `jsonTypeOf`, `declaresType`, `typeTag` — JSON Schema resolution shared by the walkers of
`validate-jsonschema` and `references-default`), `helpers/links` (`collectInternalRefs`),
`helpers/mediaType` (`parseMediaType`, `mediaTypeEssence`, `canonicalMediaType`, `publicFormOf`,
`mediaTypeMatches`, `mediaTypeAllowed`, `sniffMediaType`, `verifiedMediaType`, `contentMatchesMediaType`,
`EXTENSION_BY_TYPE`, `NEUTRAL_TYPE`, `NEUTRAL_EXTENSION`),
`helpers/persistence` (`fieldDefinition`), `helpers/renderer` (`renderFailed`),
`helpers/migrations` (`migrationFailed`) and `helpers/shape-migrations` (`runShapeMigrations`,
`guardStorage`, `refusalOf`, `blobOpsOf`, `blobSha256`, `answerOf`, `orderStorages`,
`orderMigrations`, `compareVersions`, `readStorageVersions`, `storageVersionOf`, `sha256Of`,
`storageMigrationFailed`, `STORAGE_VERSIONS`, `STORAGE_VERSIONS_SCHEMA`, `OFFLINE_COMMAND`,
`UPDATE_COMMAND`).

`errors` re-exports `@michaelthielemann/kestrel/errors` and `@michaelthielemann/kestrel/result` and
stays at its top-level path. `testing/*` (`fakePersistence`, `fakeAuthn`, `fakeMedia`, `result`) are
test doubles and assertion helpers for the contract suites — neither frozen nor a `helpers/*` runtime
helper.
