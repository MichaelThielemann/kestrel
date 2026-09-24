import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} } // bus
    ,{ use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", acquireTimeoutMs: 15000 } }
  ],
  triggers: [],
});
