# references/default
Referential integrity for internal references of `content@1`, backed by its own index collection
`references_index` (`fromType`, `fromId`, `field`, `locale`, `toTarget`, `toId`, `via`, `broken`,
`checkedAt`). Two origins are indexed, told apart by `via`: `"field"` for `ref` fields and `"body"`
for `kestrel:<type>:<id>` strings and `{ type: "internal", collection, id }` objects anywhere inside
a `json` field (every locale; a type that is not a configured target is ignored). Rows written
before `via` existed read as `"field"`.
A bare id inside a `json` field is indexed (as `"body"`) when `schemas` gives that field a JSON
Schema: `schemas: { "pages.body": "schemas/pages.body.json" }` (a path relative to the project root,
or an inline schema). Every non-empty string at a position marked `"x-kestrel-ref": "<target>"` is an
id of that target. The walk follows local `$ref`s (a marker next to a `$ref` counts), every `allOf`
member, every `oneOf`/`anyOf` branch that fits the value (by its `type` const, else by its `type`; a
branch without `type` fits any value), `properties`, `additionalProperties` and `items`; it errs
towards finding an id. A key that does not name a `json` field of the model, or a file that cannot be
read, fails setup. A file is read once at setup; with `watch: true` it is read again when its
modification time changes, and a failed re-read keeps the last good schema.
The index rebuilds itself at boot whenever its extraction config changes: setup hashes the targets,
the `ref` and `json` fields, the locales and the keywords the walk reads of each schema, compares the
hash with the one stored in `references_meta`, and on a difference (or no stored hash) rebuilds the
index before the module is ready. A failed rebuild fails the boot. A schema that changes while the
process runs (with `watch`) applies to later writes; the next boot rebuilds. Documents written while
the module was not loaded are not picked up while the hash stays the same; `references.rebuild`
repairs that.
Targets are declared in config: `targets: { pages: { content: "pages" }, media: { media: true } }`;
every `ref` field must point to a configured target (checked at boot). A target is a type of
`content@1` (`{ content: "<type>" }`), the files of the `media@1` provider (`{ media: true }`), or a
collection of the consumer's own (`{ collection: "<name>" }`) — never another module's collection,
whose storage is that module's alone. A media target counts a file as existing exactly while
`media@1` reports it as ready, so an upload still in flight or a file being deleted is a dangling
reference for `references.check` and `references.scan`, while a file in `media-default`'s trash,
which `media@1` still reports as ready, is not; `media@1` is an optional dependency, and
setup fails, naming the target, when a media target is configured and no module provides it.
Every method returns a `Result`: a failure is an `Err(KestrelError)`, never an exception. Only
wiring bugs throw (unknown type, unknown target).

| Step | reads | writes | codes |
|---|---|---|---|
| `references.check:<type>` | – | – | DANGLING_REF (`details.fields`, `details.refs`), TRANSIENT |
| `references.index:<type>` | `result.id` | – | TRANSIENT |
| `references.unindex:<type>` | `params.id` | – | VALIDATION (missing id), TRANSIENT |
| `references.guard:<target>` | `params.id` | – | VALIDATION (missing id), CONFLICT (`details.referrers`), TRANSIENT |
| `references.referrers:<target>` | `params.id` | `result` | VALIDATION (missing id), TRANSIENT |
| `references.referrersMany:<target>` | – | `result` | VALIDATION, TRANSIENT |
| `references.guardAll:<target>` | `result.ids` | – | CONFLICT (`details.referenced`), TRANSIENT |
| `references.dropReferenced:<target>` | `result.ids`, `result.skipped?` | `result.ids`, `result.skipped` | TRANSIENT |
| `references.scan` | – | `result` | TRANSIENT |
| `references.report` | – | `result` | TRANSIENT |
| `references.rebuild` | – | `result` | TRANSIENT |

`references.check:<type>` runs before `content.create/update` (DANGLING_REF when a referenced id
does not exist); `references.index:<type>` after `content.create/update` and
`references.unindex:<type>` after `content.remove` keep the index current; `references.guard:<target>`
before a delete (CONFLICT when the index still holds referrers); `references.scan` (cron) re-checks
every entry and marks `broken`; `references.report` lists broken entries (optional `target` in the
payload); `references.rebuild` clears and refills the index from all content;
`references.referrers:<target>` answers "who references `params.id`" (for delete dialogs);
`references.referrersMany:<target>` answers the same question for up to 200 comma-separated
`payload.ids` at once, `{ [id]: Referrer[] }`.
`references.guardAll:<target>` refuses a whole batch when one of `result.ids` is referenced;
`references.dropReferenced:<target>` lets the batch go on without them instead: it keeps the
unreferenced ids in `result.ids` and appends `{ id, reason: "referenced" }` per referenced one to
`result.skipped` (started when the result has none), leaving every other field of the result as it
is. Between `media.selectTrash` (or `media.selectAllTrash`, `media.selectExpiredTrash`) and
`media.purge` it keeps a purge from deleting a file that a page still uses and reports that file to
the caller.
Not included: cascading deletes, automatic clearing of dangling references, expanding refs on read.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-references-default` – module `references/default`: provides no contract; requires `content@1`, `persistence@1`; optional `media@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `targets` | record | yes | – |
| `schemas` | record | no | – |
| `watch` | boolean | no | `false` |

| Step | Summary | Reads | Writes | Input | Output | Errors | Portable | Atomic-safe |
|---|---|---|---|---|---|---|---|---|
| `references.check:<arg>` | Referenced ids of <arg> must exist | – | – | object | – | 400 a referenced document does not exist | – | yes |
| `references.index:<arg>` | Index the references of a <arg> document | `result.id` | – | – | – | – | – | yes |
| `references.unindex:<arg>` | Drop indexed references of a <arg> document | `params.id` | – | – | – | 400 missing id | – | yes |
| `references.guard:<arg>` | Refuse deletion while <arg> is referenced | `params.id` | – | – | – | 400 missing id; 409 still referenced | – | yes |
| `references.referrers:<arg>` | Documents referencing a <arg> | `params.id` | `result` | – | object[] | 400 missing id | – | yes |
| `references.referrersMany:<arg>` | Documents referencing each of up to 200 <arg> ids | – | `result` | ?ids: string | object | 400 missing ids or more than 200 ids | – | yes |
| `references.guardAll:<arg>` | Refuse while any of result.ids of <arg> is referenced | `result.ids` | – | – | – | 409 still referenced | – | no |
| `references.dropReferenced:<arg>` | Keep only the <arg> ids in result.ids that nothing references and add each referenced one to result.skipped as { id, reason: "referenced" }, so a following delete leaves it alone | `result.ids`, `result.skipped?` | `result.ids`, `result.skipped` | – | { ids: string[], skipped: object[], … } | – | – | no |
| `references.scan` | Re-check every reference | – | `result` | – | { checked: number, broken: number, … } | – | – | no |
| `references.report` | Broken references | – | `result` | ?target: string | object[] | – | – | yes |
| `references.rebuild` | Rebuild the reference index | – | `result` | – | { documents: number, entries: number, … } | – | – | no |

Used by 17 of 109 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
