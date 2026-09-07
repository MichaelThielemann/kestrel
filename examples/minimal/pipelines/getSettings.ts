import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "getSettings",
  steps: ["authn.identifyUser", "authz.require:settings.read", "content.get:settings"],
});
