# Custom pipelines and actions

Every `/api/` endpoint, including the eight CRUD operations on your own collections, is a pipeline — this page covers hooking your own logic into that engine.

## What a pipeline is

A pipeline is a named step list fronted by declarative `access`/`csrf`/`ipAllowlist` gates. Instead of forking the CRUD engine, hook your own logic in with `definePipeline` and `registerPipeline`, both auto-imported like the rest of Kestrel's server API (import explicitly from `@michaelthielemann/kestrel-core` only outside a Kestrel app). Full design: [Pipeline engine](../internals/pipeline-engine.md).

Every pipeline resolves to a URL under `/api/`: `/api/<pipeline>` for a collection-less pipeline, `/api/<collection>/<pipeline>[/<id>]` for one scoped to a collection. A path segment is read as a record id only when it is a positive integer, and only in the third position — the second segment is always the pipeline name, never an id, so `/api/pages/42` 404s rather than reading record `42`. A record read looks like `/api/pages/readOne/42`.

## Where a pipeline lives

Drop a file under `server/pipelines/` — in your project, an extension, or any layer — that exports a builder function. Unlike `server/collections/**`, this directory is a plain convention, not an auto-discovered one: you register explicitly, from a Nitro plugin.

```ts
// server/pipelines/notes.ts
import { Effect } from 'effect'

export function buildNotePipelines() {
  return [
    definePipeline({
      name: 'archiveNote',
      on: { collection: 'notes' },
      access: { role: 'admin' },
      steps: [
        syncStep('archive', (ctx) => Effect.sync(() => {
          ctx.output = { archived: true, id: ctx.id }
        })),
      ],
      ui: { kind: 'record', label: { en: 'Archive' }, icon: 'trash', confirm: true },
    }),
  ]
}
```

```ts
// server/plugins/01.register-note-pipelines.ts
import { buildNotePipelines } from '../pipelines/notes'

export default defineNitroPlugin(() => {
  for (const def of buildNotePipelines()) registerPipeline(def)
})
```

`archiveNote` is now live at `POST /api/notes/archiveNote/<id>`, admin-gated, and surfaces as a row action in the notes list (`ui.kind: 'record'`) with a confirm dialog. A step's `fn` always returns an `Effect`, never a bare value or a `Promise` — build it with `syncStep`/`asyncStep`, not a raw object literal; see below.

**Your plugin always runs after Kestrel's.** Kestrel's own plugins run in a declared boot order, pushed ahead of Nitro's normal directory scan; your own plugin is picked up by that scan afterward, so it runs after every one of Kestrel's regardless of its filename prefix or your layer's position in `extends`. This is safe because nothing reads the collection/pipeline registry at plugin init, only at request time — the same invariant the built-in pipelines rely on, installing lazily on first request rather than at boot. Never resolve a pipeline (`getCollection()`, `allCollections()`, or a pipeline-resolving call) at plugin scope; violating it happens to work in-repo by accident of plugin scan order and breaks silently, with an empty registry, for a consumer whose layer order differs. See [Pipeline engine](../internals/pipeline-engine.md) for the scan-order mechanics.

If you genuinely need your plugin to run *before* Kestrel's — the boot order above is otherwise fixed — register it via your own Nuxt module's `nitro:config` hook instead of a `server/plugins/` file: `nuxt.hook('nitro:config', (nitro) => { nitro.plugins ||= []; nitro.plugins.unshift(yourResolvedPluginPath) })`. That hook fires at the same phase Kestrel's own module uses, and an `unshift` lands your plugin ahead of Kestrel's block regardless of your module's position in `nuxt.config`'s `modules` array — Kestrel's own order-assertion tolerates it, since it only requires its block to stay contiguous and in order, not to start at index 0.

`registerAfterStep` (below) and its `eventsOf` helper are auto-imported the same way as `definePipeline` and `registerPipeline` — no separate convention to learn.

## Patching a default pipeline

Override one of the eight standard ops (`createOne`/`createMany`/`readOne`/`readMany`/`updateOne`/`updateMany`/`deleteOne`/`deleteMany`) by giving your def that exact `name` and either a full `steps` list or a `patch`:

```ts
definePipeline({
  name: 'updateOne',
  on: { collection: 'products' },
  patch: [
    { before: 'persist', step: sanitizeDescription },  // insert before an anchor step
    { after: 'transform', step: computeSlug },          // insert after an anchor step
    { replace: 'resolveSlug', step: myOwnSlugStep },     // swap a whole step out
  ],
})
```

A handful of steps are **sealed**: `validate`, `checkConcurrency`, `assertUnique`, `assertAllExist`, `persist`, `emitEvents`, `fetch`, `populate`, `validateOut`, and `loadRollbackTarget`. Patching one of those requires an explicit opt-out, because it drops a guarantee the engine otherwise enforces (record validation, unique slugs, optimistic concurrency, read-scope authorization):

```ts
{ replace: 'assertUnique', step: myLooserUniqueCheck, unsafeReplace: true }
```

Only one `patch` def is allowed per (collection, op) — a second `patch`, or a second full-`steps` replacement, for the same target collides at registration. An `after`-only def (one with no `steps` and no `patch`) is the one exception: any number of those can share a target, which is why after-steps (below) stack freely. Among defs that do apply, a collection-agnostic one runs before a collection-specific one targeting the same op.

A full `steps` replacement discards the built-in step list entirely, including any sealed step it contained — so a `steps`-replacement def is responsible for re-adding `validate`/`persist`/etc. itself if it still needs them. `patch` is almost always the better choice for a standard op precisely because it keeps every step you don't name.

## A brand-new action

A def whose `name` is not one of the eight standard ops, carrying a full `steps` list, is a new action rather than an override. Give it `on: { collection }` to scope it to one collection (patchable and overridable per collection like the built-ins), or omit `on` entirely for a global, collection-less pipeline at `/api/<name>` — this is how `login`, `publish`, and `_pipelines` are defined.

A custom pipeline is a write (`POST`) unless it declares `read: true`, which routes it as `GET` instead and exempts it from the CSRF gate — the right shape for something like an export a browser can navigate to directly.

```ts
import { Effect } from 'effect'

const exportCsvPipeline = definePipeline({
  name: 'exportCsv',            // no `on` ⇒ a global pipeline, not scoped to a collection
  access: { role: 'admin' },
  read: true,                    // GET-routed, no CSRF gate
  steps: [
    syncStep('export', (ctx) => Effect.sync(() => {
      ctx.output = buildCsv(ctx)
    })),
  ],
})

registerPipeline(exportCsvPipeline)
```

Registered this way — typically from a Nitro plugin, as with `archiveNote` above — `exportCsv` is live at `GET /api/exportCsv`: a route with no collection segment at all, distinct from a collection-scoped custom action's `/api/<collection>/<name>/<id>` shape.

## After-steps

Run something after a write commits, without touching the main step list:

```ts
import { Effect } from 'effect'

registerAfterStep({
  step: asyncStep('notifySlack', (ctx) => Effect.gen(function* () {
    // eventsOf(ctx) returns the WriteEvent[] emitEvents snapshotted for this run — before/after rows per affected record.
    yield* Effect.tryPromise({ try: () => notify(eventsOf(ctx)), catch: (error) => error })
  })),
  critical: false,                  // false: logged, save stays green. true: the failure becomes the response.
  ops: ['createOne', 'updateOne'],  // defaults to every standard write op
  on: { collection: 'orders' },     // omit to run on every collection
})
```

Any number of independent plugins can each register their own after-step onto the same operation — there is no single-registration collision to coordinate. `critical: true` is deliberately rare: the row is already committed by the time an after-step runs, so a critical failure becomes a response describing a save that did happen, just not fully.

`ops` and `on` narrow when a given after-step runs; omit both and it fires on every standard write, for every collection. `registerAfterStep` is the composable way to attach behavior to a write without touching that collection's own pipeline def at all, which matters when the write and the reaction to it belong to different, independently maintained layers.

## Access declarations, including public reads

Every pipeline needs an `access` declaration or the engine refuses to run it at request time. A def that patches or replaces a standard op inherits that op's built-in `access` unless it declares its own; a brand-new pipeline has no built-in to inherit from, so it stays refused until it declares `access`. To open a read to anonymous visitors (as `pages` does), declare `scope: 'published'` explicitly; a public read without it throws at evaluation time, since an omitted scope would otherwise silently expose drafts:

```ts
definePipeline({
  name: 'readMany',
  on: { collection: 'announcements' },
  access: { public: true, scope: 'published' },
  steps: [/* … */],
})
```

`resource` authorizes against a name other than the collection — useful for a tooling-style read you don't want a public grant on the bare collection to reach: `access: { role: 'admin', resource: 'announcements/audit' }`.

A custom write pipeline gets the `csrf` gate by default — set `csrf: false` to opt out, which is what you want for a webhook or another server calling in without a browser session, since there's no same-origin cookie to check. It also inherits the global IP allowlist unless the def sets `ipAllowlist: false` to exempt itself from it.

The same rule applies to `registerAccessGrant`, auto-imported like the rest of Kestrel's server API (explicit import from `@michaelthielemann/kestrel-access` only outside a Kestrel app), the server-plugin seam an opt-in extension uses to open a narrow hole in the default-deny guard: a read grant for any non-admin role must set `scope: 'published'` explicitly — an omitted or `'all'` scope throws at registration, since every non-admin role is read-limited to published content regardless of what the grant says.

```ts
registerAccessGrant('editor', { action: 'read', resource: 'announcements/audit', scope: 'published' })
```

## `ui` — surfacing as an admin action

A custom write pipeline scoped to a collection (`on: { collection }`) appears automatically in that collection's admin list, with no admin-side code — whether or not it declares `ui`; without one it falls back to `kind: 'bulk'` and a button labelled with the raw pipeline name. A `ui` block just customises how it's presented. A global, collection-less pipeline never surfaces this way, whatever its `ui` block says — the admin only ever lists actions for a specific collection.

```ts
ui: {
  kind: 'bulk' | 'record' | 'both',  // defaults to 'bulk' if omitted
  label: { en: 'Archive', de: 'Archivieren' },
  icon: 'trash',                     // an icon-registry name; unknown names render a blank slot, not an error
  confirm: true,                     // plain confirm() before running
}
```

`kind: 'bulk'` and `kind: 'both'` always POST `{ ids }` to `/api/<collection>/<name>`; only `kind: 'record'` POSTs to `.../<name>/<id>` with no body. `both` means "offered on both surfaces" — bulk bar and row — not "two wire shapes": a `both` action must read `ctx.input.ids`, since a row click sends an array of one id the same way the bulk bar does. `icon` applies to row actions only; the bulk bar renders the label text and never reads `icon`. `updateMany` never surfaces this way even if you patch it — its status-patch use stays the admin's own Publish/Unpublish presentation. `rollback` is the other built-in exception: it needs a revision number a generic action button has no way to supply, so its `ui` metadata stays introspection-only; see [Revisions](./revisions.md).

Adding a `ui` block customises the admin presentation; registering a collection-scoped custom write pipeline at all is what puts it in the admin, `ui` or not. The introspection dashboard below flags any pipeline that carries a `ui` block with an "action" badge, so you can confirm it registered correctly without opening the admin at all.

## The introspection dashboard

`GET /__kestrel/dashboard` (dev only — 404s outside `import.meta.dev`) renders every routable pipeline (route, step chain, gates, `after[]`), the plugin boot order, and the registered collections, gathered live from the registry — so it reflects your own collections, overrides, and custom pipelines, not just the built-ins. It is the same idea as `_pipelines`/`?debug=pipeline`, but as one browsable page instead of a JSON response per request.

Because it reads the live registry rather than static source, it is also the fastest way to check that a `patch` landed where you intended: the rendered step chain for `updateOne` on your collection shows your inserted step at its actual position, sealed steps marked as such, next to every other def that touched the same pipeline.

## Opt-in extensions

Some features ship as separate, opt-in extension layers — their own packages, never bundled with the core. Compose them after the core, and they add field types, composables, and components you wire into your own collections and blocks:

```ts
// nuxt.config.ts
export default defineNuxtConfig({ extends: ['@michaelthielemann/kestrel', '@michaelthielemann/galleries-secure'] })
```

`kestrel-galleries-secure` is one example: the foundation for zero-knowledge encrypted galleries (images and folder names encrypted client-side with a password; the server only ever stores ciphertext). It ships primitives — a `secureGallery` field type, the `useSecureGallery` composable, and a `<SecureGalleryView>` component — not a finished collection or block, so you assemble your own around them.

## See also

- [Custom field types](./custom-field-types.md) — the other main extension point, for a new field kind rather than a new endpoint.
- [Publishing](./publishing.md) — `POST /api/publish` and the publish-status read.
- [Pipeline engine](../internals/pipeline-engine.md) — gates, steps, sealed/critical-section rules, and the plugin scan-order proof.
- [Extension points](../internals/extension-points.md) — the full list of seams an extension layer can hook, beyond pipelines.
