import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listUsers",
  steps: ["authn.requireUser", "authz.require:users.manage", "authn.listUsers"],
});
