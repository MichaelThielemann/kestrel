import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "emptyMediaTrash",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.delete", "media.selectAllTrash", "references.dropReferenced:media", "media.purge", "images.removeMany", "events.emit:media.deleted", "events.relay"],
});
