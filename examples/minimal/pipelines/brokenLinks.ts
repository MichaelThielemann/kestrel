import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "brokenLinks",
  steps: ["authn.requireUser", "authz.require:pages.manage", "links.report"],
});
