import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "updateMedia",
  steps: ["authn.requireUser", "authz.require:media.write", "media.update", "events.emit:media.updated"],
});
