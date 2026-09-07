import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "sweepRateLimits",
  steps: ["ratelimit.sweep"],
});
