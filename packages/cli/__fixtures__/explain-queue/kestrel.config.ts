import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/app.db" } },
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-events-queue", config: { lanes: { slow: ["onB"] }, relayPipelines: ["onA"] } },
    { use: "./modules/things.ts", config: {} },
  ],
  triggers: [
    { http: "POST /things", pipeline: "makeThing" },
    { event: "thing.done", pipeline: "onA" },
    { event: "thing.done", pipeline: "onB" },
  ],
  http: null,
});
