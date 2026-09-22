import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "unpublishPage",
  steps: ["delivery.unpublish:pages", "delivery.exportLlms"],
});
