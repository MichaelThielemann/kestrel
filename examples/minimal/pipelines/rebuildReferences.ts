import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "rebuildReferences",
  steps: ["authn.requireUser", "authz.require:pages.manage", "references.rebuild"],
});
