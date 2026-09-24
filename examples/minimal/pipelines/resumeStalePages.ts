import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "resumeStalePages",
  steps: ["delivery.resumeStale"],
});
