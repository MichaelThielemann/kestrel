import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pagePublishStatus",
  steps: ["authn.requireUser", "authz.require:pages.manage", "delivery.readStatus:pages"],
});
