import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listRoles",
  steps: ["authn.requireUser", "authz.require:users.manage", "authz.listRoles"],
});
