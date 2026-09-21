import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "retryReassignRevisionAuthor",
  steps: ["authn.requireUser", "authz.require:users.manage", "authn.verifyUser:reassignTo", "revisions.reassignAuthor"],
});
