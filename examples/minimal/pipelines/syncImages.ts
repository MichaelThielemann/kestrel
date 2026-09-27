import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "syncImages",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:images.manage", "images.sync"],
});
