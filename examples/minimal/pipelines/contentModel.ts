import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "contentModel",
  steps: ["authn.requireUser", "content.describeModel"],
});
