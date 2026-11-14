import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deleteUser",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:users.manage", { atomic: ["authn.deleteUser"] }, "events.emit:user.deleted?with=result", "events.relay"],
});
