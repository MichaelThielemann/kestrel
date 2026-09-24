import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "serveMediaFile",
  steps: ["media.serve"],
});
