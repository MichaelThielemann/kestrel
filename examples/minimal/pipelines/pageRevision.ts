import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pageRevision",
  steps: ["authn.requireUser", "authz.require:pages.manage", "revisions.read:pages"],
});
