import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "syncPublicMedia",
  steps: ["media.syncPublic", "images.syncPublic"],
});
