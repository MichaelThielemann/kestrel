import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pageReferrersMany",
  steps: ["authn.requireUser", "authz.require:pages.manage", "references.referrersMany:pages"],
});
