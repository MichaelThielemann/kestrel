import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "createMediaFolder",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.write", "media.createFolder"],
});
