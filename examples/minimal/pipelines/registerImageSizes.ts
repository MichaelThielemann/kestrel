import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "registerImageSizes",
  steps: ["authn.requireUser", "authz.require:images.write", "images.register"],
});
