import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deleteMedia",
  steps: ["authn.requireUser", "authz.require:media.delete", "references.guard:media", "media.remove", "images.remove", "events.emit:media.deleted", "events.relay"],
});
