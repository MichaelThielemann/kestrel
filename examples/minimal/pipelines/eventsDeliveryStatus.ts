import { definePipeline } from "../modules.ts";

export default definePipeline({
  name: "eventsDeliveryStatus",
  steps: ["authn.requireUser", "authz.require:system.manage", "events.readDeliveryStatus"],
});
