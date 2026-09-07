import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "activateUser",
  steps: ["authn.requireUser", "authz.require:users.manage", "authn.activateUser"],
});
