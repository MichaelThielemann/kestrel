import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "updatePage",
  steps: [{ atomic: ["content.update:pages", "site.indexPath:pages"] }, "site.announcePaths"],
});
