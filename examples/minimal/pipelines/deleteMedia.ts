import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deleteMedia",
  steps: ["authn.requireUser", "authz.require:media.delete", "references.guard:media", "images.remove", "media.remove", "events.emit:media.deleted"],
});
