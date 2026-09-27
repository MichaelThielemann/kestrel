import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pageTree",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:pages.manage", "site.readTree:pages"],
});
