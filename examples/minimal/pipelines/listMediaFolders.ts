import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listMediaFolders",
  steps: ["authn.identifyUser", "authz.require:media.read", "media.listFolders"],
});
