import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "publishAllPages",
  steps: ["authn.requireUser", "authz.require:pages.manage", "delivery.publishAll:pages", "redirects.export", "delivery.exportLlms"],
});
