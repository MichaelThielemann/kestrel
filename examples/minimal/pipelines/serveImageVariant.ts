import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "serveImageVariant",
  steps: ["authn.identifyUser", "authz.require:media.read", "images.serve"],
});
