import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "restoreMedia",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:media.write", "media.restore", "images.showMany", "events.emit:media.restored", "events.relay"],
});
