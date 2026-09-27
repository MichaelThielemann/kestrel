import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "insightsStats",
  steps: ["authn.requireUser", "authz.requireRole", "authz.require:insights.read", "insights.readStats"],
});
