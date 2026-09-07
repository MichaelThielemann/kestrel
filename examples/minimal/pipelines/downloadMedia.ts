import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "downloadMedia",
  steps: ["authn.identifyUser", "authz.require:media.read", "media.download"],
});
