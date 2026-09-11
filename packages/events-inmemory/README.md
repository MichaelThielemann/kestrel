# events/inmemory
`events@1` inside one process: handlers run in registration order, `emit` resolves after the
last one; a throwing handler does not stop the rest, but `emit` then rejects with an
`AggregateError` collecting all of them. Step `events.emit:<name>` throws
`{ eventId, event, at, runId, identity, params, id }` of the running pipeline — `eventId` is a fresh
UUID per emit (a dedup key for consumers), `runId` the id of the emitting run; a listener failure is
logged and does not fail the step. Required for event triggers in `kestrel.config.ts`.
Provides the core's `triggers.event` hook: it subscribes the configured `{ event, pipeline }` entries
to its own bus and returns the unsubscribe the core calls on `stop()`. The envelope's `runId` is
passed to the handler pipeline as `parentRunId`, so its step log lines point back at the run that
emitted the event.
Not included: delivery across processes or restarts (use a broker-backed events module).

<!-- kestrel-docs:start -->
## Generated from the manifest
`@michaelthielemann/kestrel-events-inmemory` – module `events/inmemory`: provides `events@1`; provides the event trigger hook.

Config: `{}` – nothing to set.

| Step | Summary | Reads | Writes | Input | Output | Errors |
|---|---|---|---|---|---|---|
| `events.emit:<arg>` | Emit event "<arg>" to every subscribed handler pipeline | – | – | – | – | – |

Pipelines in `examples/minimal` using these steps:

- **createPage** (POST /pages): `authn.requireUser` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → `references.check:pages` → `content.create:pages` → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → **`events.emit:page.created`**
- **createUser** (POST /users): `authn.requireUser` → `authz.require:users.manage` → `authn.createUser` → **`events.emit:user.created`**
- **deactivateUser** (DELETE /users/:id): `authn.requireUser` → `authz.require:users.manage` → `authn.deactivateUser` → **`events.emit:user.deactivated`**
- **deleteMedia** (DELETE /media/:id): `authn.requireUser` → `authz.require:media.delete` → `references.guard:media` → `images.remove` → `media.remove` → **`events.emit:media.deleted`**
- **deletePage** (DELETE /pages/:id): `authn.requireUser` → `authz.require:pages.delete` → `references.guard:pages` → `content.remove:pages` → `references.unindex:pages` → `links.unextract:pages` → `delivery.unpublish:pages` → `delivery.exportLlms` → **`events.emit:page.deleted`**
- **deletePageTranslation** (DELETE /pages/:id/translations/:locale): `authn.requireUser` → `authz.require:pages.write` → `content.removeTranslation:pages` → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → **`events.emit:page.translationRemoved`**
- **login** (POST /login): `ratelimit.check:login` → `authn.login` → **`events.emit:auth.loggedIn`**
- **logout** (POST /logout): `authn.requireUser` → `authn.logout` → **`events.emit:auth.loggedOut`**
- **updateMedia** (PATCH /media/:id): `authn.requireUser` → `authz.require:media.write` → `media.update` → **`events.emit:media.updated`**
- **updatePage** (PATCH /pages/:id): `authn.requireUser` → `authz.require:pages.write` → `validate.check:pages.body` → `validate.sanitize:pages.body` → `validate.check:pages.body` → `references.check:pages` → `content.update:pages` → `references.index:pages` → `links.extract:pages` → `delivery.publish:pages` → `delivery.exportLlms` → **`events.emit:page.updated`**
- **uploadMedia** (POST /media): `authn.requireUser` → `authz.require:media.write` → `sanitize.svg` → `media.upload` → **`events.emit:media.uploaded`**

<!-- kestrel-docs:end -->
