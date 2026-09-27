import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "labelPageRevision",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:pages.write", "revisions.label:pages"],
});
