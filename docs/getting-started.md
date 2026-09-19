# Getting Started

From an empty folder to a running instance with a login, a content type and one step you wrote
yourself. Everything here is a consumer project: Kestrel is installed from npm, nothing is cloned.

Requires Node 22.13 or newer (`node:sqlite`) and pnpm. Config, pipeline and module files are
TypeScript and are loaded by Node's built-in type stripping — there is no build step.

## 1. Install

Install the core plus the modules the project needs. The core ships no contracts and no modules,
so a bare install boots an empty shell.

Start with a `package.json` that marks the project as an ES module:

```json
{ "name": "my-site", "private": true, "type": "module" }
```

```
pnpm add @michaelthielemann/kestrel @michaelthielemann/kestrel-contracts \
  @michaelthielemann/kestrel-persistence-sqlite @michaelthielemann/kestrel-authn-single \
  @michaelthielemann/kestrel-authz-roles @michaelthielemann/kestrel-content-default
```

A password for `authn-single` is stored as a scrypt hash, never in plain text:

```
node -e "import('@michaelthielemann/kestrel-authn-single/impl').then(m => console.log(m.hashPassword(process.argv[1])))" -- secret123
```

## 2. `kestrel.config.ts`

Operational wiring: which modules are active with what settings, and which trigger starts which
pipeline. Modules are listed in dependency order — a module that `requires` a contract comes after
the module that provides it.

```ts
import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data.db" } },
    { use: "@michaelthielemann/kestrel-authn-single", config: { username: "editor", passwordHash: "scrypt$…", roles: ["editor"] } },
    { use: "@michaelthielemann/kestrel-authz-roles", config: { roles: { editor: ["pages.*"] }, anonymous: ["pages.read"] } },
    {
      use: "@michaelthielemann/kestrel-content-default",
      config: {
        locales: ["en"],
        defaultLocale: "en",
        types: {
          pages: {
            kind: "multi",
            fields: {
              slug: { type: "slug", required: true, unique: true },
              title: { type: "text", required: true },
            },
          },
        },
      },
    },
  ],
  triggers: [
    { http: "POST /login", pipeline: "login" },
    { http: "GET /pages", pipeline: "listPages" },
    { http: "POST /pages", pipeline: "createPage" },
  ],
  http: { port: 4000 },
});
```

Every key, its type and its default: [`configuration.md`](configuration.md). The content model —
field types, `single` vs. `multi`, `localized`, `ref` — is described in
[`contracts.md`](contracts.md) § Content is configuration, not modules.

## 3. `modules.ts`

Optional but recommended: it binds `definePipeline` to the steps the configured modules actually
register, so a mistyped step name is a `tsc` error instead of a boot error. The list must hold the
same modules as `config.modules`.

```ts
import { pipelineDefiner, type StepCatalogue } from "@michaelthielemann/kestrel";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";
import authnSingle from "@michaelthielemann/kestrel-authn-single";
import authzRoles from "@michaelthielemann/kestrel-authz-roles";
import contentDefault from "@michaelthielemann/kestrel-content-default";

const modules = [persistenceSqlite, authnSingle, authzRoles, contentDefault] as const;
export default modules;
export type KnownStep = StepCatalogue<typeof modules>;
export const definePipeline = pipelineDefiner<KnownStep>();
```

## 4. `pipelines/`

Functional wiring: every file exports one pipeline, and a pipeline is a name plus an ordered list
of step names. All business logic lives here; the file shows the complete flow.

```ts
// pipelines/login.ts
import { definePipeline } from "../modules.ts";
export default definePipeline({ name: "login", steps: ["authn.login"] });
```

```ts
// pipelines/listPages.ts
import { definePipeline } from "../modules.ts";
export default definePipeline({
  name: "listPages",
  steps: ["authn.identifyUser", "authz.require:pages.read", "content.list:pages"],
});
```

```ts
// pipelines/createPage.ts
import { definePipeline } from "../modules.ts";
export default definePipeline({
  name: "createPage",
  steps: ["authn.requireUser", "authz.require:pages.write", "content.create:pages"],
});
```

`authn.identifyUser` sets an identity when a token is present but never rejects;
`authz.require:pages.read` then lets an anonymous request through because `anonymous` grants that
permission. There is no second pipeline for the public case — see
[`pipelines.md`](pipelines.md) § Anonymous and Logged In.

## 5. Run it

`kestrel` reads `kestrel.config.ts` and `pipelines/*.ts` from the current directory.

```
./node_modules/.bin/kestrel
```

```
$ curl -s -X POST localhost:4000/login -H 'content-type: application/json' \
    -d '{"username":"editor","password":"secret123"}'
{"token":"d0e5a3ce-…","identity":{"id":"editor","claims":{"roles":["editor"]}}}

$ curl -s -X POST localhost:4000/pages -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' -d '{"slug":"home","title":"Home"}'
{"id":"e4980063-…","createdAt":1789830745921,"updatedAt":1789830745921,"slug":"home","title":"Home","_translations":{"en":false}}

$ curl -s localhost:4000/pages
{"items":[{"id":"e4980063-…","slug":"home","title":"Home",…}],"total":1}
```

Each request logs one line per step with its duration and outcome, plus one `http` line, and every
response carries `X-Kestrel-Run-Id`. `GET /health` answers without running a pipeline.

A misconfiguration stops the boot instead of failing at runtime: an unknown step name, a missing
contract, a step reading context a previous step never wrote, or a cycle between modules ends with
`boot failed` naming the module and the reason.

## 6. Your own module

A module is a `module.ts` with a default export from `defineModule()`. It does not have to fulfil
a contract — `provides: []` and a step map is enough. Put it anywhere in the project and point
`use` at the file with a relative path.

Modules declare their config with a Zod schema, so the project needs `zod` as its own dependency:

```
pnpm add zod
```

```ts
// modules/greet/module.ts
import { z } from "zod";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import type { Context } from "@michaelthielemann/kestrel/context";
import { ok } from "@michaelthielemann/kestrel/result";

export default defineModule({
  name: "greet/default",
  provides: [],
  requires: [],
  configSchema: z.object({ greeting: z.string().default("hello") }),

  setup: async (config) => ({ greeting: config.greeting }),

  steps: (greet) => ({
    say: async (ctx: Context) => ok({ ...ctx, result: { message: greet.greeting } }),
  }),

  describe: () => ({
    say: { summary: "Put a greeting on the result", reads: [], writes: ["result"] },
  }),
});
```

`name` must read `<module>/<submodule>`; its first segment becomes the step prefix, so the step
above is `greet.say`. `provides`, `requires` and `configSchema` are required even when empty —
without them boot rejects the file as "not a defineModule() result". `describe()` is required as
soon as a module has steps, and the runner holds every step to the `writes` it declares.

Wire it up and call it:

```ts
// kestrel.config.ts
{ use: "./modules/greet/module.ts", config: { greeting: "hi there" } },
…
{ http: "GET /greet", pipeline: "greet" },
```

```ts
// pipelines/greet.ts
import { definePipeline } from "../modules.ts";
export default definePipeline({ name: "greet", steps: ["greet.say"] });
```

```
$ curl -s localhost:4000/greet
{"message":"hi there"}
```

Add the module to `modules.ts` as well, and `greet.say` becomes part of the typed step catalogue.

## Next

| Goal | Read |
|---|---|
| Understand the model behind all of this | [`architecture.md`](architecture.md) |
| Every config key and both CLIs | [`configuration.md`](configuration.md) |
| Write real steps: context, errors, arguments, tests | [`pipelines.md`](pipelines.md) |
| Define your own contract | [`contracts.md`](contracts.md) |
| Ship a module as a package | [`submodule-template.md`](submodule-template.md) |
| A full instance with every module wired up | [`../examples/minimal`](../examples/minimal) |
