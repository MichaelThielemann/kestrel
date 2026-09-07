import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";
import { defineMigration } from "@michaelthielemann/kestrel-migrations-default/helpers";

const trimTitle = defineMigration({
  id: "2026-09-03-trim-title",
  collection: "pages",
  up: ({ document }) => {
    const title = document.title;
    if (typeof title !== "string") return null;
    const trimmed = title.trim();
    return trimmed === title ? null : { ...document, title: trimmed };
  },
});

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: ":memory:" } },
    {
      use: "@michaelthielemann/kestrel-authn-single",
      config: {
        username: "editor",
        // password: kestrel-demo
        passwordHash: "scrypt$15233414288dd1d644855dc092f3774f$c7e5ae3a04256111b1f1e17178012b3824d7618701aa12a8a386bae97f0d4ecaf5e4bf211f153b32b0063d92cac951bad78e055643419c28640833db52c9daff",
        roles: ["editor"],
      },
    },
    { use: "@michaelthielemann/kestrel-authz-roles", config: { roles: { editor: ["pages.*"] } } },
    {
      use: "@michaelthielemann/kestrel-content-default",
      config: {
        locales: ["de", "en"],
        defaultLocale: "de",
        types: {
          pages: {
            kind: "multi",
            fields: {
              slug: { type: "slug", required: true, unique: true, localized: true },
              title: { type: "text", required: true, localized: true },
              status: { type: "enum", options: ["draft", "published"], required: true },
            },
          },
        },
      },
    },
    { use: "@michaelthielemann/kestrel-site-default", config: {} },
    { use: "@michaelthielemann/kestrel-migrations-default", config: { migrations: [trimTitle], mode: "apply" } },
  ],
  triggers: [
    { http: "POST /login", pipeline: "login" },
    { http: "POST /pages", pipeline: "createPage" },
    { http: "GET /site/*path", pipeline: "resolvePage" },
    { event: "page.created", pipeline: "countPages" },
  ],
  http: null,
});
