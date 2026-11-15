import { describe, expect, it } from "vitest";
import { createHarness, LOCATION } from "../harness.fixture.ts";
import { keys, parseJson } from "../layout.ts";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import { CloudFoundryRun, RUN_LOCATION } from "./cloudFoundryRun.fixture.ts";
import { updateKeys } from "./layout.ts";
import { UPDATE_EXIT } from "./types.ts";

const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);

function documentsUnder(bucket: MemoryBucket, prefix: string): Array<{ key: string; value: unknown }> {
  const found: Array<{ key: string; value: unknown }> = [];
  for (const [key, object] of bucket.objects) if (key.startsWith(prefix) && key.endsWith(".json")) found.push({ key, value: parseJson(object.data) });
  return found;
}

describe("credentials that are part of the tool's fixed text", { timeout: 60_000 }, () => {
  it.each([
    { accessKeyId: "kestrel", secretAccessKey: "backup" },
    { accessKeyId: "ops", secretAccessKey: "kestrel-ops" },
  ])("leave the manifest, the journal and the JSON output of a backup and its restore intact (access key $accessKeyId, secret $secretAccessKey)", async (credentials) => {
    const bucket = new MemoryBucket("fixed-text");
    const h = createHarness({ store: memoryStore(bucket) });
    const env = { OPS_ACCESS_KEY: credentials.accessKeyId, OPS_SECRET_KEY: credentials.secretAccessKey };
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"], { env });
      expect(backup.code, backup.stderr).toBe(0);
      expect(backup.json.schema).toBe("kestrel-ops/backup-create@1");
      const id = String(backup.json.id);
      const manifest = parseJson(bucket.objects.get(LOCATION + keys.manifest(id))?.data ?? new Uint8Array());
      expect(field(manifest, "schema")).toBe("kestrel-ops/backup@1");
      expect(field(field(manifest, "tool"), "name")).toBe("@michaelthielemann/kestrel-ops");
      expect(field(backup.json.manifest, "schema")).toBe("kestrel-ops/backup@1");
      const journal = documentsUnder(bucket, `${LOCATION}runs/`);
      expect(journal.length).toBeGreaterThan(2);
      expect(journal.filter(({ value }) => field(field(value, "data"), "backupId") === id).length).toBeGreaterThan(0);

      const verified = await h.run(["backup", "verify", id, "--json"], { env });
      expect(verified.code, verified.stderr).toBe(0);
      const restored = await h.run(["restore", "--backup", id, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"], { env });
      expect(restored.code, restored.stderr).toBe(0);
      expect(restored.json.schema).toBe("kestrel-ops/restore@1");
    } finally {
      await h.dispose();
    }
  });

  it("let a deploy through the stub Cloud Foundry platform verify, and its rollback restore the recorded configuration", async () => {
    const credentials = { accessKeyId: "kestrel", secretAccessKey: "backup" };
    const bucket = new MemoryBucket("kestrel-test");
    const s = await CloudFoundryRun.create(memoryStore(bucket), { version: "6.0.0" });
    try {
      s.addRelease({ version: "6.0.1" });
      const prepared = await s.update(["prepare"], { credentials });
      expect(prepared.code, prepared.stderr).toBe(UPDATE_EXIT.done);
      expect(prepared.json.schema).toBe("kestrel-ops/update-prepare@1");
      const envBefore = { ...s.api.env };
      const deployed = await s.update(["deploy"], { credentials });
      expect(deployed.code, deployed.stderr).toBe(UPDATE_EXIT.done);
      const runId = String(deployed.json.runId);
      const run = await s.run(runId);
      expect(run.state).toBe("verified");
      const configuration = parseJson(bucket.objects.get(RUN_LOCATION + updateKeys.configuration("prod", runId))?.data ?? new Uint8Array());
      expect(field(configuration, "schema")).toBe("kestrel-ops/configuration@1");
      expect(field(field(configuration, "env"), "SITE_NAME")).toEqual({ value: "Example" });
      const manifest = parseJson(bucket.objects.get(RUN_LOCATION + keys.manifest(run.cutoverBackup ?? ""))?.data ?? new Uint8Array());
      expect(field(manifest, "schema")).toBe("kestrel-ops/backup@1");
      for (const { key, value } of documentsUnder(bucket, `${RUN_LOCATION}updates/prod/receipts/`)) expect(field(value, "schema"), key).toBe("kestrel-ops/update-receipt@1");

      const status = await s.update(["status"], { credentials });
      expect(status.code, status.stderr).toBe(UPDATE_EXIT.done);
      expect(status.json.schema).toBe("kestrel-ops/update-status@1");

      const rolled = await s.update(["rollback"], { credentials, answers: { "rollback-accepted": "prod" } });
      expect(rolled.code, rolled.stderr).toBe(UPDATE_EXIT.done);
      expect((await s.run(runId)).state).toBe("rolled-back");
      expect(s.api.env).toEqual(envBefore);
      expect(s.current().version).toBe("6.0.0");
    } finally {
      await s.dispose();
    }
  });
});
