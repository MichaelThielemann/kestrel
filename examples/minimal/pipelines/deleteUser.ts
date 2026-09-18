import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deleteUser",
  steps: ["authn.requireUser", "authz.require:users.manage", "authn.deleteUser", "events.emit:user.deleted"],
});
