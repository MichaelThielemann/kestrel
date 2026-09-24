import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listMediaFolders",
  steps: ["authn.requireUser", "authz.require:media.read", "media.listFolders"],
});
