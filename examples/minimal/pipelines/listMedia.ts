import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listMedia",
  steps: ["authn.identifyUser", "authz.require:media.read", "media.list", "images.attach"],
});
