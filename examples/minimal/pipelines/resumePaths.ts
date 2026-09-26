import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "resumePaths",
  steps: ["site.resumePaths"],
});
