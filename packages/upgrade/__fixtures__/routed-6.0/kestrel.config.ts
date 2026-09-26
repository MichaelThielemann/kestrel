import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } },
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
              status: { type: "enum", options: ["draft", "published"], localized: true },
            },
          },
        },
      },
    },
    { use: "@michaelthielemann/kestrel-site-default", config: { routes: { pages: { home: "home", liveWhen: { status: "published" } } } } },
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-events-direct", config: {} },
  ],
  triggers: [{ event: "site.pathsMoved", pipeline: "pathsMoved" }],
  pipelinesDir: "./pipelines",
});
