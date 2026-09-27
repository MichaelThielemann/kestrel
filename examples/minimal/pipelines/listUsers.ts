import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listUsers",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:users.manage", "authn.listUsers"],
});
