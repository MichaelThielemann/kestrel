# examples/h3
An h3 application (the framework under Nuxt/Nitro) hosting an embedded Kestrel via
`@michaelthielemann/kestrel-h3`: the host keeps its own routes (`GET /`), Kestrel's triggers are
mounted under `/api`. Config and pipelines are shared with `examples/embedded`.

`POST /api/login` with `{ "username": "editor", "password": "kestrel-demo" }` returns a token;
`POST /api/pages` needs it as `Authorization: Bearer <token>`.
