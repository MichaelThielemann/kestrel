import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "registerImageSizesBoot",
  steps: ["images.register"],
});
