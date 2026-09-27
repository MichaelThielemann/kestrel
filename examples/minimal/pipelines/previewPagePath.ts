import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "previewPagePath",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:pages.write", "site.previewPath:pages"],
});
