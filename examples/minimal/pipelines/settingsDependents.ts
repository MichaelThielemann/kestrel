import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "settingsDependents",
  steps: ["delivery.markDependents:settings", "delivery.requestIndexes"],
});
