import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deactivateUser",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authn.deactivateUser", "events.emit:user.deactivated", "events.relay"],
});
