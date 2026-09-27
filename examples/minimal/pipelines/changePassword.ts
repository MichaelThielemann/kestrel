import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "changePassword",
  steps: ["authn.requireUser", "authz.requireRole", "authn.changePassword"],
});
