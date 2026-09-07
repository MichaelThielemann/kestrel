import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "renderRedirects",
  steps: ["redirects.render"],
});
