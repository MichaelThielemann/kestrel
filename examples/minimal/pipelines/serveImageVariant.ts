import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "serveImageVariant",
  steps: ["images.serve"],
});
