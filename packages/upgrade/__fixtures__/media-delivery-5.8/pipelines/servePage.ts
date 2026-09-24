import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "servePage",
  steps: ["content.get:pages"],
});
