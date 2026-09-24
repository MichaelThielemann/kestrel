import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "publishNote",
  steps: ["events.emit:note.published"],
});
