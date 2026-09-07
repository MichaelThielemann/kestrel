import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "imagesStatus",
  steps: ["authn.requireUser", "authz.require:images.read", "images.readStatus"],
});
