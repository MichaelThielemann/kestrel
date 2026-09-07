import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "readPage",
  steps: ["authn.identifyUser", "authz.require:pages.read", "content.get:pages?status=published"],
});
