import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", busyTimeoutMs: 20000 } },
    { use: "@michaelthielemann/kestrel-blobstore-s3", config: { region: "eu-west-1" } },
  ],
  triggers: [],
});
