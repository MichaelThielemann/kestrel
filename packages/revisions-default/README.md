# revisions/default

**What.** `revisions@1` on `persistence@1`: an append-only history per collection, document and
locale. Every save records a full snapshot of the fields as they were stored, together with the
author, the status at that moment and a pointer to its parent revision.

**Why.** Editors want the state of last Tuesday back, and they want to see how a page got where it
is. A snapshot per save is the cheapest model that answers both; deltas only pay off once the space
hurts. The module records what the content steps already saved and never writes content itself, so
it works with any `content@1` implementation and with no content module at all.

**Branching.** `parentId` is the whole mechanism. A normal save's parent is the head of that
(collection, document, locale); a save whose run restored revision R gets R as its parent, which
forks the line at R. Switching branches is therefore the same gesture as going back: restoring the
tip of a branch and saving again continues that branch. The head is kept per group in
`revisions_heads`; the document row itself stays the only live state.

**No merges.** Restoring is a new save, so the model is append-only and two branches never have to
be reconciled. Merging block trees (repeaters recursively, word diffs on text) would cost more than
the whole history view, for a conflict the system cannot even detect today — there is no optimistic
locking and no presence display, so in practice one editor works per document and locale with
last-write-wins. If conflicts ever matter, `expectedUpdatedAt` is the lever, not a merge.

**Config.** `keep` (50) newest revisions per document and locale, `maxSnapshotBytes` (1 MiB),
`pruneOnWrite` (true), `statusField` (`status`) and `liveStatuses` (`["published"]`) name the field
that decides whether a recorded state was live, `maxLimit` (100) caps a list page.

**Retention.** `prune` keeps, per document and locale: the newest `keep`, every revision that was
ever live, every labelled one, the head, every branch tip and every branch point. Everything else
goes, and the survivors are re-parented onto their nearest surviving ancestor, so a `parentId` chain
never breaks and the shape of the tree is preserved. `revisions.prune` is the cron step for the
whole store; with `pruneOnWrite` every save prunes its own group as well.

**Size guard.** A snapshot beyond `maxSnapshotBytes` is recorded as `skipped: true` with no content
and a `warn` log line. The save itself never fails for it; only restoring such a revision does, with
409.

**Steps.** `revisions.record:<collection>` after `content.create`/`content.update`,
`revisions.restore:<collection>` before the ordinary update chain (it only fills the body, the
existing steps validate, sanitize, save, index and publish), plus `list`, `read`, `label`, `prune`,
`remove` and `removeTranslation`.

**Not included.** No diff — a block-aware diff belongs in the admin UI. No merge, no conflict
detection, no undo stack (that is the editor's, per session). No pipelines and no routes: the
consumer wires those, `docs/api.md` shows the example instance's.

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-revisions-default` – module `revisions/default`: provides `revisions@1`; requires `persistence@1`; optional `content@1`.

| Config | Type | Required | Default |
|---|---|---|---|
| `keep` | integer | no | `50` |
| `maxSnapshotBytes` | integer | no | `1048576` |
| `pruneOnWrite` | boolean | no | `true` |
| `statusField` | string | no | `"status"` |
| `liveStatuses` | array | no | `["published"]` |
| `maxLimit` | integer | no | `100` |

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `revisions.record:<arg>` | Record the saved <arg> document from the result as a revision; its parent is the head, or the revision a restore put on the context | `result` | – | ?locale: string | – | 503 the revision could not be written |
| `revisions.list:<arg>` | Revisions of one <arg> document and locale, newest first and without snapshots | `params.id` | `result` | ?locale: string, limit: integer, offset: integer | { items: object[], total: number, head: string \| null, … } | 400 missing id |
| `revisions.read:<arg>` | One revision of a <arg> document including its snapshot | `params.id`, `params.revisionId` | `result` | – | { id: string, collection: string, documentId: string, locale: string, parentId: string \| null, createdAt: number, author: object, kind: "save" \| "restore", label: string \| null, status: string \| null, live: boolean, bytes: number, skipped: boolean, snapshot: object \| null, … } | 400 missing id or revisionId; 404 no such revision |
| `revisions.restore:<arg>` | Put a <arg> revision's snapshot into the body, so the steps behind it save it like any other write and branch the history at that revision | `params.id`, `params.revisionId` | `body`, `payload`, `revisionParent` | – | – | 400 missing id or revisionId; 404 no such revision; 409 the revision carries no snapshot |
| `revisions.label:<arg>` | Name a <arg> revision, or clear its name with null; a labelled revision is never pruned | `params.id`, `params.revisionId` | `result` | { label: string \| null } | { id: string, collection: string, documentId: string, locale: string, parentId: string \| null, createdAt: number, author: object, kind: "save" \| "restore", label: string \| null, status: string \| null, live: boolean, bytes: number, skipped: boolean, … } | 400 missing id or revisionId; 404 no such revision |
| `revisions.prune` | Apply the retention rules to every recorded document and locale | – | `result` | – | { inspected: number, removed: number, … } | – |
| `revisions.remove:<arg>` | Drop every revision of a <arg> document, in every locale | `params.id` | – | – | – | 400 missing id |
| `revisions.removeTranslation:<arg>` | Drop the revisions of one locale of a <arg> document | `params.id` | – | ?locale: string | – | 400 missing id |

Pipelines in `examples/minimal` using these steps:

- **createPage** (POST /pages): `authn.requireUser` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → `references.check:pages` → `content.create:pages` → **`revisions.record:pages`** → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.created`
- **deletePage** (DELETE /pages/:id): `authn.requireUser` → `authz.require:pages.delete` → `references.guard:pages` → `content.remove:pages` → **`revisions.remove:pages`** → `references.unindex:pages` → `links.unextract:pages` → `delivery.unpublish:pages` → `delivery.exportLlms` → `events.emit:page.deleted`
- **deletePageTranslation** (DELETE /pages/:id/translations/:locale): `authn.requireUser` → `authz.require:pages.write` → `content.removeTranslation:pages` → **`revisions.removeTranslation:pages`** → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.translationRemoved`
- **labelPageRevision** (PATCH /admin/pages/:id/revisions/:revisionId): `authn.requireUser` → `authz.require:pages.write` → **`revisions.label:pages`**
- **pageRevision** (GET /admin/pages/:id/revisions/:revisionId): `authn.requireUser` → `authz.require:pages.manage` → **`revisions.read:pages`**
- **pageRevisions** (GET /admin/pages/:id/revisions): `authn.requireUser` → `authz.require:pages.manage` → **`revisions.list:pages`**
- **pruneRevisions** (cron 15 3 * * *): **`revisions.prune`**
- **restorePageRevision** (POST /admin/pages/:id/revisions/:revisionId/restore): `authn.requireUser` → `authz.require:pages.write` → **`revisions.restore:pages`** → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → `references.check:pages` → `content.update:pages` → **`revisions.record:pages`** → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.restored`
- **updatePage** (PATCH /pages/:id): `authn.requireUser` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → `references.check:pages` → `content.update:pages` → **`revisions.record:pages`** → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → `events.emit:page.updated`

<!-- kestrel-docs:end -->
