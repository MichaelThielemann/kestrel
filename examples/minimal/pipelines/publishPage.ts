import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "publishPage",
  steps: ["delivery.publish:pages", "delivery.requestLlms"],
});
