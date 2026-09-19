import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "pruneRevisions",
  steps: ["revisions.prune"],
});
