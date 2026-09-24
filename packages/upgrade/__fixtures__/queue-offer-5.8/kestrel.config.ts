import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-events-inmemory", config: {} },
    { use: "@michaelthielemann/kestrel-events-direct", config: {} },
    { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db", acquireTimeoutMs: 15000 } },
    { use: "./notes.ts", config: {} },
  ],
  triggers: [
    { http: "POST /notes", pipeline: "createNote" },
    { event: "note.created", pipeline: "onNoteCreated" },
  ],
  pipelinesDir: "./pipelines",
});
