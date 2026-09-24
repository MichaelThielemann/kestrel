import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "serveMediaFile",
  steps: ["authn.identifyUser", "authz.require:media.read", "media.serve"],
});
