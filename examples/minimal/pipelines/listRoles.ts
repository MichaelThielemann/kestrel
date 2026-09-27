import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listRoles",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authz.listRoles"],
});
