# migrations/default
`migrations@1` on top of `content@1`: every pending migration (`{ id, collection, up }` in config)
runs exactly once, in config order, against every document of its collection and every stored
locale of that document, validated against the current model and — when a `validate@1` provider is
registered — against the consumer's JSON schemas. A migration is recorded in the ledger
(`content_migrations`) only after it succeeds; a failing migration leaves the documents it already
rewrote as they are (no transactions across documents) and names the migration, the document and
the locale in its error. No per-document events; a successful non-dry `apply()` that ran at least
one migration emits exactly one `migrations.applied` with the applied ids and total changed
document count.
Config: `migrations` (`{ id, collection, up }[]`, `id` matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`,
unique, `collection` naming a type in `content.model().types` — otherwise boot fails), `mode`
(`"apply"` default, `"check"` fails boot listing what's pending, `"off"` runs nothing at boot),
`chunk` (paging size, default 50).
Steps: `migrations.list` (`{ applied, pending }`), `migrations.apply` (`payload.dry === true` reports
changes without writing). Both write `result` and read nothing. `apply` answers `CONFLICT` (409)
while another `apply()` is already running, `MIGRATION_FAILED` (500) with the failing migration's
own message and `details: { migration, document, locale?, problems? }`, and `TRANSIENT` (503,
retryable) when the ledger or `content@1` fails transiently; `list` answers `TRANSIENT` only.
Schema evolution: changing a stored field or block shape is a migration, not a one-off script — see
`helpers` (`@michaelthielemann/kestrel-migrations-default/helpers`, pure, no core import):
`defineMigration`, `mapBlocks(document, type, fn, blocksField = "body")` (depth-first, slots before
the node itself, `fn` returning `null` removes the node), `renameBlock`, `renameProp`, `omit`. An
example: moving a `serviced-apartments` block's `props.images` into its first
`props.categories` entry —
```ts
defineMigration({
  id: "serviced-apartments-images-to-categories",
  collection: "pages",
  up: ({ document }) =>
    mapBlocks(document, "serviced-apartments", (block) => {
      const props = block.props ?? {};
      const images = props.images;
      const categories = (props.categories as Array<Record<string, unknown>> | undefined) ?? [];
      if (!Array.isArray(images) || categories.length === 0) return block;
      const [first, ...rest] = categories;
      return { ...block, props: omit({ ...props, categories: [{ ...first, images }, ...rest] }, "images") };
    }),
});
```
and a rename: `renameBlock(document, "serviced-apartments", "apartments")`.
The boot-time `migrations.applied` (mode `"apply"`) has no subscribers yet — event triggers
subscribe only after every module's `setup()` has run — while an admin-triggered `apply()` does
reach them; after a partial failure the event still fires, covering only the migrations that were
applied before the failing one.
Not included: `down` migrations (point-in-time recovery is the way back), transactions, file
discovery of migration modules, a CLI — all a consumer concern (see kestrel-web `#kestrel/migrations`).
