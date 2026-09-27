import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "setSettings",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:settings.write", "validate.check:settings.navigation", { atomic: ["content.set:settings"] }, "events.emit:settings.updated", "events.relay"],
});
