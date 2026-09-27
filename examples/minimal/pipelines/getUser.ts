import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "getUser",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authn.getUser"],
});
