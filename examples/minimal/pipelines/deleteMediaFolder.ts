import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deleteMediaFolder",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.delete", "media.listFolderItems", "references.guardAll:media", "media.removeFolder", "images.removeMany", "events.emit:media.deleted", "events.relay"],
});
