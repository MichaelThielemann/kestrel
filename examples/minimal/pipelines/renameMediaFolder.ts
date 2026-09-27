import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "renameMediaFolder",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.write", "media.renameFolder"],
});
