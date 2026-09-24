import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "repairPublicMedia",
  steps: ["authn.requireUser", "authz.require:media.manage", "media.syncPublic", "images.syncPublic"],
});
