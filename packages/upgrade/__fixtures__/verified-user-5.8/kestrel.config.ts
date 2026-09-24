import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";

export default defineConfig({
  modules: [
    { use: "@michaelthielemann/kestrel-authn-multi", config: {} },
    { use: "@michaelthielemann/kestrel-revisions-default", config: {} },
  ],
  triggers: [
    { http: "POST /revisions/retry", pipeline: "retryReassignRevisionAuthor" },
    { event: "revision.retryReassign", pipeline: "retryReassignRevisionAuthor" },
  ],
  pipelinesDir: "./pipelines",
});
