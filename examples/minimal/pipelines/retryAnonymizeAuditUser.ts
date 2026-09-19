import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "retryAnonymizeAuditUser",
  steps: ["authn.requireUser", "authz.require:users.manage", "audit.anonymize"],
});
