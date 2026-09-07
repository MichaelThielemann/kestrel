import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "listPages",
  steps: ["authn.identifyUser", "authz.require:pages.read", "content.list:pages?status=published"],
});
