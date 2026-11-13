import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } },
    {
      use: "@michaelthielemann/kestrel-delivery-static",
      config: { types: { pages: {} }, prefix: "site/", llms: { siteUrl: "https://example.org", full: true } },
    },
  ],
  triggers: [{ http: "POST /admin/publish-all/pages", pipeline: "publishAllPages" }],
  pipelinesDir: "./pipelines",
});
