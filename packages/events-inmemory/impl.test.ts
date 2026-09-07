import { eventsContractTests } from "@michaelthielemann/kestrel-contracts/events.contract.test";
import { createEventsInmemory } from "./impl.ts";

eventsContractTests(async () => createEventsInmemory());
