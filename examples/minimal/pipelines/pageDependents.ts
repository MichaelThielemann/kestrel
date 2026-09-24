import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pageDependents",
  steps: ["delivery.markDependents:pages"],
});
