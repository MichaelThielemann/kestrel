import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "rebuildPathsAfterMigrations",
  steps: ["site.planRebuild", { atomic: ["site.applyRebuild"] }, "site.announcePaths"],
});
