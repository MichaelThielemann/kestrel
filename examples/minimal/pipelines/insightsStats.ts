import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "insightsStats",
  steps: ["authn.requireUser", "authz.require:insights.read", "insights.readStats"],
});
