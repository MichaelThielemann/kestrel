import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "me",
  steps: ["authn.requireUser", "authn.loadIdentity"],
});
