import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "purgeMedia",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.delete", "media.selectTrash", "references.dropReferenced:media", "media.purge", "images.removeMany", "events.emit:media.deleted", "events.relay"],
});
