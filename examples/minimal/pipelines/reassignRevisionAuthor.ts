import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "reassignRevisionAuthor",
  steps: ["revisions.reassignAuthor"],
});
