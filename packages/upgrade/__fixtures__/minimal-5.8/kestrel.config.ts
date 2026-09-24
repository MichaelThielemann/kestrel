import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", acquireTimeoutMs: 5000, busyTimeoutMs: 8000 } },
  ],
  triggers: [],
  pipelinesDir: "./pipelines",
});
