import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pathsMovedRedirects",
  steps: ["redirects.recordMoves", "redirects.export"],
});
