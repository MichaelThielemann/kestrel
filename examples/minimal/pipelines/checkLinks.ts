import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "checkLinks",
  steps: ["links.check"],
});
