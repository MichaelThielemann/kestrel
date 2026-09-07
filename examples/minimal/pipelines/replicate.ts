import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "replicate",
  steps: ["replication.sync"],
});
