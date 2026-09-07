import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "generateImageVariants",
  steps: ["images.generate"],
});
