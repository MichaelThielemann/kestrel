import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "retryAnonymizeAuditUser",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authn.requireAbsentUser", "audit.anonymize", "events.emit:user.auditAnonymizeRetried", "events.relay"],
});
