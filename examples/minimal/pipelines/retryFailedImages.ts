import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "retryFailedImages",
  steps: ["authn.requireUser", "authz.require:images.manage", "images.retryFailed"],
});
