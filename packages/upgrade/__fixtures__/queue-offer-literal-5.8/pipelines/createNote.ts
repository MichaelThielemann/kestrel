import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";

export default definePipeline({
  name: "createNote",
  steps: ["notes.create", "events.emit:note.created"],
});
