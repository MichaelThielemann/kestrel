import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pageRevisions",
  steps: ["authn.requireUser", "authz.require:pages.manage", "revisions.list:pages"],
});
