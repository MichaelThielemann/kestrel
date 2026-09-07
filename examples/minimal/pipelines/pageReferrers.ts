import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pageReferrers",
  steps: ["authn.requireUser", "authz.require:pages.manage", "references.referrers:pages"],
});
