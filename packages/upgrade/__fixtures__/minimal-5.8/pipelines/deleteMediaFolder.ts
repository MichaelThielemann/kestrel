import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "deleteMediaFolder",
  steps: ["authn.requireUser", "media.folderItems", "media.delete:folder"],
});
