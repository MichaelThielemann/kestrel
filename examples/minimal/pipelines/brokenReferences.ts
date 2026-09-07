import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "brokenReferences",
  steps: ["authn.requireUser", "authz.require:pages.manage", "references.report"],
});
