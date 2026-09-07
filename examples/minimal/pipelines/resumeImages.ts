import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "resumeImages",
  steps: ["images.resume"],
});
