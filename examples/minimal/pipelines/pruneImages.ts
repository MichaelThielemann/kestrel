import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pruneImages",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:images.manage", "images.prune"],
});
