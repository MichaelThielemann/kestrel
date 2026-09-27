import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "updateUser",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authz.validateRoles:roles", "authn.updateUser", "events.emit:user.updated", "events.relay"],
});
