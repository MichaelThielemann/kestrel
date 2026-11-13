import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "publishAllPages",
  steps: ["delivery.publishAll:pages", "delivery.exportLlms"],
});
