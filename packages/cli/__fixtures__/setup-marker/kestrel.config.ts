import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [{ use: "./modules/marker.ts", config: {} }],
  triggers: [],
});
