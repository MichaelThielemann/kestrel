import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pathsMovedDelivery",
  steps: ["delivery.markMoved"],
});
