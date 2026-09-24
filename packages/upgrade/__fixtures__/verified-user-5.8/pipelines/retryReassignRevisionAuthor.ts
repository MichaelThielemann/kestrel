import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "retryReassignRevisionAuthor",
  steps: ["authn.requireUser", "authz.require:revisions.manage", "revisions.reassignAuthor"],
});
