import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "reassignRevisionAuthor",
  steps: ["authn.verifyUser:result.reassignTo", "revisions.reassignAuthor"],
});
