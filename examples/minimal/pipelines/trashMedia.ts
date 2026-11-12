import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "trashMedia",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.delete", "media.trash", "images.hideMany", "events.emit:media.trashed", "events.relay"],
});
