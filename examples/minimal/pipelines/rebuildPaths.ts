import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "rebuildPaths",
  steps: ["authn.requireUser", "authz.require:pages.manage", "site.planRebuild", { atomic: ["site.applyRebuild"] }, "site.announcePaths"],
});
