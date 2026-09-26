import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "pathsMoved",
  steps: ["site.resumePaths"],
});
