import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "onNoteCreated",
  steps: ["notes.onCreated"],
});
