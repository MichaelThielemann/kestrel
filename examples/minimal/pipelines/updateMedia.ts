import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "updateMedia",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.write", "media.update", "events.emit:media.updated", "events.relay"],
});
