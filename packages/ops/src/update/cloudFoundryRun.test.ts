import { describe } from "vitest";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import { updateEndToEnd } from "./endToEnd.fixture.ts";

describe("an update run of an app on the stub Cloud Foundry platform", () => {
  updateEndToEnd(() => ({ store: memoryStore(new MemoryBucket("kestrel-test")), close: () => undefined }));
});
