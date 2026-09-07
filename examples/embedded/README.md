# examples/embedded
Kestrel without its HTTP server: `http: null` in the config, modules and pipelines imported
statically, `kestrel.run(pipeline, input)` called directly. `kestrel.triggers.http` plus
`matchRoute` let a host framework (Nuxt/Nitro, Express, …) map its own requests onto the
configured triggers. Event and cron triggers still run after `start()`.

Writes are authenticated like everywhere else: `authn-single` holds one user (`editor` /
`kestrel-demo`), `authz-roles` grants it `pages.*`, and `createPage` runs
`authn.requireUser` + `authz.require:pages.write`. `POST /login` returns a token that the host
passes on as `Authorization: Bearer <token>` in `headers`.
