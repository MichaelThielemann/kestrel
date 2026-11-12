import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "trashMediaFolder",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.delete", "media.trashFolder", "images.hideMany", "events.emit:media.trashed", "events.relay"],
});
