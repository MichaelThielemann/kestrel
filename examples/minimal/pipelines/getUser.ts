import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "getUser",
  steps: ["authn.requireUser", "authz.require:users.manage", "authn.getUser"],
});
