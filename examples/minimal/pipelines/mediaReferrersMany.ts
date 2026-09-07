import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "mediaReferrersMany",
  steps: ["authn.requireUser", "authz.require:pages.manage", "references.referrersMany:media"],
});
