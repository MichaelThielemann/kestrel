import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "deleteMediaFolder",
  steps: ["authn.requireUser", "authz.require:media.delete", "media.folderItems", "references.guardAll:media", "images.removeMany", "media.removeFolder"],
});
