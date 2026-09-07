import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "getMedia",
  steps: ["authn.identifyUser", "authz.require:media.read", "media.get", "images.attach"],
});
