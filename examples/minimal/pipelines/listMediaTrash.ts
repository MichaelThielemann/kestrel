import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listMediaTrash",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.write", "media.listTrash"],
});
