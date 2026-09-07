import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "setPassword",
  steps: ["authn.requireUser", "authz.require:users.manage", "authn.setPassword"],
});
