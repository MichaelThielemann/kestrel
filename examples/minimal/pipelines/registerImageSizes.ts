import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "registerImageSizes",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:images.write", "images.register"],
});
