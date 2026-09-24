import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "mediaDependents",
  steps: ["delivery.markDependents:media"],
});
