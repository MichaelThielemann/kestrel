# references/default
Referential integrity for internal references of `content@1`, backed by its own index collection
`references_index` (`fromType`, `fromId`, `field`, `locale`, `toTarget`, `toId`, `via`, `broken`,
`checkedAt`). Two origins are indexed, told apart by `via`: `"field"` for `ref` fields and `"body"`
for `kestrel:<type>:<id>` strings and `{ type: "internal", collection, id }` objects anywhere inside
a `json` field (every locale; a type that is not a configured target is ignored). Rows written
before `via` existed read as `"field"`.
Targets are declared in config: `targets: { pages: { content: "pages" }, media: { collection:
"media_items" } }`; every `ref` field must point to a configured target (checked at boot).
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
Not included: cascading deletes, automatic clearing of dangling references, expanding refs on read.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-references-default` – module `references/default`: provides no contract; requires `content@1`, `persistence@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `targets` | record | yes | – |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `references.check:<arg>` | Referenced ids of <arg> must exist | – | – | object | – | 400 a referenced document does not exist |
| `references.index:<arg>` | Index the references of a <arg> document | `result.id` | – | – | – | – |
| `references.unindex:<arg>` | Drop indexed references of a <arg> document | `params.id` | – | – | – | 400 missing id |
| `references.guard:<arg>` | Refuse deletion while <arg> is referenced | `params.id` | – | – | – | 400 missing id; 409 still referenced |
| `references.referrers:<arg>` | Documents referencing a <arg> | `params.id` | `result` | – | object[] | 400 missing id |
| `references.referrersMany:<arg>` | Documents referencing each of up to 200 <arg> ids | – | `result` | ?ids: string | object | 400 missing ids or more than 200 ids |
| `references.guardAll:<arg>` | Refuse while any of result.ids of <arg> is referenced | `result.ids` | – | – | – | 409 still referenced |
| `references.scan` | Re-check every reference | – | `result` | – | { checked?: number, broken?: number, … } | – |
| `references.report` | Broken references | – | `result` | ?target: string | object[] | – |
| `references.rebuild` | Rebuild the reference index | – | `result` | – | { documents?: number, entries?: number, … } | – |

Used by 14 of 82 pipelines in `examples/minimal`.

<!-- kestrel-docs:end -->
