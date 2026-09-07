import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "setSettings",
  steps: ["authn.requireUser", "authz.require:settings.write", "validate.check:settings.navigation", "content.set:settings", "delivery.exportLlms"],
});
