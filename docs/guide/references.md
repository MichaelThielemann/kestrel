# Links, references and dead links

How Kestrel keeps the cross-references between content records honest as records change, publish, or disappear.

## Internal links

The internal `link` field (including one nested inside a richtext body, a block, or a repeater) points at
another record by collection and id. Kestrel resolves that pointer to a real URL only when the target is
**publicly linkable**: the record exists, its collection is page-like (routable), and — if that collection
has a `status` column — the record is published. A target that is missing, non-page-like, or a draft with
a `status` column resolves to `#` instead, so a draft's slug never leaks into published HTML and a link to
a non-routable collection never fabricates a path.

```ts
// simplified link-resolution check, once the target record has been fetched
function isPubliclyLinkable(row: Record<string, unknown> | undefined, hasStatus: boolean): boolean {
  if (!row) return false
  return !hasStatus || row.status === 'published'
}
```

A media field is different: it embeds the file's URL directly and carries no status gate of its own, so a
media reference resolves regardless of the target's state (a dangling id resolves to `null`). A relation
field is not — the related read is published-only on every read, so a relation to a draft or unpublished
record resolves to `null` (single) or is dropped from the array (`many`). A relation into a collection the
caller could not read directly is left unexpanded entirely (raw id only, no `$<name>` sibling). See
[field-types.md](./field-types.md) § `relation`.

Richtext internal-link markers and the editor's preview resolve through the same status-gated check, so the
preview never shows a link the published page wouldn't also bake.

## What a change invalidates

Publishing, unpublishing, or deleting a record re-renders more than just that record's own page — its
listings, explicit referrers, and descendants can all go stale at the same time. Unpublish and delete are
the one exception that skips the publish step: they act immediately, on the save itself — the record's own
page is pruned and its listings, referrers, and descendants re-render right away. See
[publishing.md](./publishing.md) § What a save invalidates for the full event table and the
`output.publishOnSave` setting.

## Dead-reference warnings

Re-rendering a referrer only makes its *output* honest — the dead link becomes `#`. But a referrer whose own
record has unpublished edits is a held-back route (see [publishing.md](./publishing.md) § The incremental
publisher): it keeps serving its old file until it is itself published, so its baked link stays stale until
then. Kestrel additionally **warns** the editor that a referrer now points at a dead target, across every
reference type: relation and media fields, the internal `link` field, richtext internal links, the `seo`
social image, and any of those nested inside a block or repeater field.

A target counts as dead when:

- it is **deleted** — always, regardless of collection; or
- it is **unpublished** — but only when the target's collection has a `status` column, so a consumer's own
  status field is honoured automatically. A target in a status-less collection is dead only if deleted.

The report labels the reason **Deleted** or **Unpublished** (a consumer reading the API sees the wire values
`missing` and `unpublished` instead). The per-record editor warnings (list triangle, block badge, field note)
are derived on read by checking each target's current existence/status, never stored, so a warning clears
itself the moment the reference is removed or repointed, or the target is restored or republished. The
global report and the pre-delete "what links here" check below instead read a durable reference index that
is maintained asynchronously on write, so those two can briefly lag a change.

You see dead-reference warnings in three places:

- **Collection list** — a warning triangle on any row whose record has a dead reference.
- **Page builder** — a "Broken reference" badge on the offending block, rolled up to its ancestor blocks,
  plus a per-field note.
- **`/admin/references`** — a global "Broken references" report listing every referrer, its dead target, and
  the reason. The admin dashboard links here whenever the count is non-zero.

Before you delete a record, the editor also runs a referrer check and — if any exist — warns that some of
the records being deleted are referenced elsewhere and will be left with a broken link. The check is
best-effort: if it fails, the dialog still opens with a caution that references couldn't be verified rather
than a false all-clear. Unpublishing runs no such check.

## The one accepted gap

Opaque `json` columns are not typed-extracted, so a reference value buried in raw JSON is invisible to both
the invalidation model and the dead-reference report. If a field type stores record ids inside a `json`
column instead of a typed relation/media/link field, links, invalidation, and dead-reference warnings all
skip it silently. Use a typed reference field (relation, media, or `link`) whenever a value needs to
participate in reference integrity.

## Admin-only tooling routes

Broken references are also reachable outside the admin UI, though every one of these routes is admin-only:
`GET /api/brokenRefs` for the global report, `GET /api/<collection>/deadRefs/<id>` for one record's dead
references, and `GET /api/<collection>/referrers?ids=` for the "what links here" check.

## See also

- [publishing.md](./publishing.md) — the publish flow that applies these invalidations, and what a save vs.
  a publish each do.
- [configuration.md](./configuration.md) — `output.publishOnSave` and related output settings.
- [multilingual.md](./multilingual.md) — how locale interacts with routing and internal links.
- [field-types.md](./field-types.md) — the relation, media, and link field types referenced above.
- [querying.md](./querying.md) — the admin-only tooling sub-routes, including the reference routes above.
