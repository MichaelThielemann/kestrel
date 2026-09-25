import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } },
    { use: "@michaelthielemann/kestrel-media-default", config: { prefix: "media/", publicPath: "/api" } },
    { use: "@michaelthielemann/kestrel-images-default", config: { publicPath: "/api/", media: { collection: "media_items" } } },
    {
      use: "@michaelthielemann/kestrel-delivery-static",
      config: { types: { pages: {} }, prefix: "site/", media: { publicPath: "/api", target: "media/" } },
    },
    { use: "@michaelthielemann/kestrel-authz-roles", config: { anonymous: [] } },
    { use: "./modules/customMediaLinks.ts", config: {} },
  ],
  triggers: [{ http: "GET /pages/:slug", pipeline: "servePage" }],
  pipelinesDir: "./pipelines",
});
