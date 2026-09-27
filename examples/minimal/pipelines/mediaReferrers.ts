import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "mediaReferrers",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:pages.manage", "references.referrers:media"],
});
