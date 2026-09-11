import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "insightsManifest",
  steps: ["authn.requireUser", "authz.require:insights.read", "insights.readManifest"],
});
