import { afterEach, describe, expect, it } from "vitest";
import { createUpdateHarness, type UpdateHarness } from "./harness.fixture.ts";
import { waitForSeal } from "./seal.ts";

const harnesses: UpdateHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function seeded(runtime: string, sealDelayMs: number): Promise<UpdateHarness> {
  const h = createUpdateHarness({ from: { runtime }, update: { sealTimeoutSeconds: 5 } });
  harnesses.push(h);
  await h.target.start();
  await h.target.app?.seed();
  h.target.sealDelayMs = sealDelayMs;
  return h;
}

describe("waiting for the seal after a stop", () => {
  it("waits for a seal the instance writes after the platform already reports stopped", async () => {
    const h = await seeded("6.0.0", 300);
    const { stoppedAt } = await h.target.stop();
    expect((await h.target.status()).state).toBe("stopped");
    const seal = await waitForSeal(await h.context(), stoppedAt);
    expect(seal.state).toBe("sealed");
    expect(seal.seal?.segments).toBeGreaterThanOrEqual(0);
  });

  it("reports a stop without teardown as unsealed once the timeout has passed", async () => {
    const h = await seeded("6.0.0", 0);
    h.target.kill();
    const before = Date.now();
    const seal = await waitForSeal(await h.context(), before - 4_000);
    expect(seal.state).toBe("unsealed");
    expect(Date.now() - before).toBeLessThan(4_000);
  });

  it("does not wait for a runtime that writes no seal", async () => {
    const h = await seeded("5.8.1", 0);
    const { stoppedAt } = await h.target.stop();
    const before = Date.now();
    const seal = await waitForSeal(await h.context(), stoppedAt);
    expect(seal.state).toBe("unsupported");
    expect(Date.now() - before).toBeLessThan(2_000);
  });
});
