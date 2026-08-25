# Building a site with Kestrel

This is the reading order for consumers building a site with Kestrel — from a fresh scaffold through deployment and day-to-day operation. Each page stands on its own, but reading them in order builds the mental model progressively.

## Reading order

- [Getting started](./getting-started.md) — from nothing to a running site with a working `/admin`, fresh or added to an existing Nuxt project.
- [How Kestrel works](./concepts.md) — the mental model every other page assumes: collections, records, pages, draft/published, save/publish/preview.
- [Defining collections](./collections.md) — a collection is a table plus its schema, admin UI, and CRUD API, declared with `defineCollection`.
- [Field types](./field-types.md) — every built-in field type, the column it becomes, the schema it validates against, and the widget it renders.
- [Field layout and conditional fields](./field-layout.md) — arranging a collection's editor form with `fieldLayout` and showing or hiding fields with `condition`.
- [Blocks and the page builder](./blocks.md) — the ordered, nested content a page-like collection stores in `content`, authored as Vue components and edited live.
- [Media and images](./media.md) — allowed formats, size and MIME limits, responsive variants via `<KestrelImg>`, and local disk vs. S3 storage.
- [AI disclosure (EU AI Act Art. 50)](./ai-disclosure.md) — recording how a media asset was produced and handing that metadata to your templates.
- [Multiple content locales](./multilingual.md) — configuring locales, how translated records are stored, and the editor and list UI for managing them.
- [Reading data over the API](./querying.md) — the HTTP surface for filtering, sorting, paging, population, and the write-side concurrency check.
- [Saving, publishing and previewing](./publishing.md) — how save, publish, and preview differ and when each one runs.
- [Building and deploying](./deploying.md) — what gets built, the production environment, and where the output goes.
- [SEO, structured data and answer engines](./seo.md) — head tags, JSON-LD, sitemap, robots.txt, and the `llms.txt` family.
- [Redirects](./redirects.md) — authoring CMS-managed redirects and how the emitted `redirects.json` is served.
- [Configuration](./configuration.md) — `kestrel.config.ts`, every `KESTREL_*` env var and its precedence, and the env-only settings.
- [Custom pipelines and actions](./extending.md) — hooking your own logic into the pipeline engine that powers every `/api/` endpoint.
- [Custom field types and editor bodies](./custom-field-types.md) — registering a new field type or swapping the editor body for a collection.
- [Revisions and rollback](./revisions.md) — how every write becomes a restorable history snapshot.
- [Schema changes and migrations](./schema-lifecycle.md) — what happens to the database when a `defineCollection` field changes, in dev and production.
- [Links, references and dead links](./references.md) — keeping cross-references between content records honest as records change, publish, or disappear.
- [Troubleshooting](./troubleshooting.md) — symptom-to-fix entries for the footguns that come up most often.

Developing Kestrel itself, rather than a site built on it? See [../internals/README.md](../internals/README.md).

## See also

- [getting-started.md](./getting-started.md) — the first page to read, if you are starting from nothing.
- [concepts.md](./concepts.md) — the vocabulary the rest of this tree assumes.
- [troubleshooting.md](./troubleshooting.md) — the symptom index, when something already went wrong.
- [../internals/README.md](../internals/README.md) — the other door, for developing Kestrel itself.
