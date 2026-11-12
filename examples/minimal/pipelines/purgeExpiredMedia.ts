import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "purgeExpiredMedia",
  steps: ["media.selectExpiredTrash", "references.dropReferenced:media", "media.purge", "images.removeMany", "events.emit:media.deleted"],
});
