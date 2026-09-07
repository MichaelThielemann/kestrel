import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listImageSizes",
  steps: ["authn.requireUser", "authz.require:images.read", "images.listSizes"],
});
