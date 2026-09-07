import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "scanReferences",
  steps: ["references.scan"],
});
