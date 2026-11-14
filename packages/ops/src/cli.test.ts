import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, type Harness } from "./harness.fixture.ts";
import { acquireLock } from "./lock.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import type { ObjectStore } from "./store.ts";

const ID = "prod-20261001T000000Z-manual-abcd";

function counted(name: string): { h: Harness; bucket: MemoryBucket; counts: { commands: number; loads: number }; extra: () => Parameters<Harness["run"]>[1] } {
  const bucket = new MemoryBucket(name);
  const h = createHarness({ store: memoryStore(bucket) });
  h.editEnvironments((file) => {
    const prod = file.environments.prod;
    if (prod) prod.storage = { bucket: "kestrel-test", credentials: { accessKeyId: { command: ["pass", "show", "ops/key"] }, secretAccessKey: { command: ["pass", "show", "ops/secret"] } } };
  });
  const counts = { commands: 0, loads: 0 };
  return {
    h,
    bucket,
    counts,
    extra: () => ({
      runCommand: async () => {
        counts.commands += 1;
        return "credential-value-1234";
      },
      targets: {
        fake: () => {
          counts.loads += 1;
          return h.app;
        },
      },
    }),
  };
}

describe("command lines", () => {
  it("refuse an option the command does not take with exit 2 before credentials, target or store are touched", async () => {
    const { h, bucket, counts, extra } = counted("foreign-options");
    try {
      const lines = [
        ["restore", "--backup", ID, "--dry-run", "--yes"],
        ["restore", "--backup", ID, "--keep-sessions", "--yes"],
        ["restore", "--backup", ID, "--freeze"],
        ["restore", "--backup", ID, "--kind", "manual"],
        ["restore", "--backup", ID, "--latest"],
        ["restore", "--backup", ID, "--with-media"],
        ["restore", "--to", "local", "copy", "--backup", ID, "--no-safety-backup"],
        ["backup", "create", "--dry-run"],
        ["backup", "create", "--backup", ID],
        ["backup", "list", "--freeze"],
        ["backup", "verify", ID, "--dry-run"],
        ["backup", "prune", "--freeze"],
        ["status", "--with-media"],
      ];
      for (const line of lines) {
        const outcome = await h.run(line, extra());
        expect(outcome.code, line.join(" ")).toBe(2);
        expect(outcome.stderr, line.join(" ")).toMatch(/does not take --[a-z-]+/);
      }
      expect(counts).toEqual({ commands: 0, loads: 0 });
      expect(bucket.writes).toEqual([]);
    } finally {
      await h.dispose();
    }
  });

  it("report every usage error with exit 2 before credentials, target, journal or lock, also while another run holds the lock", async () => {
    const { h, bucket, counts, extra } = counted("usage-errors");
    try {
      await acquireLock(memoryStore(bucket), LOCATION, "otherrun", "backup-create", Date.now);
      const before = bucket.writes.length;
      const lines = [
        ["backup", "create", "--kind", "bogus"],
        ["restore"],
        ["restore", "--to", "remote", "x"],
        ["restore", "--to", "local", "--latest"],
        ["restore", "--to", "local", "copy"],
        ["restore", "--to", "local", "copy", "--latest", "--with-media"],
        ["restore", "--to", "local", "copy", "--latest", "--backup", ID],
        ["restore", "--backup", "not-a-backup"],
        ["restore", "--to", "local", "copy", "--backup", "not-a-backup"],
        ["backup", "verify", "../../www/about"],
        ["backup", "verify", "stage-20261001T000000Z-manual-abcd"],
        ["backup", "verify"],
        ["backup", "list", "extra"],
      ];
      for (const line of lines) {
        const outcome = await h.run(line, extra());
        expect(outcome.code, line.join(" ")).toBe(2);
      }
      expect(counts).toEqual({ commands: 0, loads: 0 });
      expect(bucket.writes.length).toBe(before);
    } finally {
      await h.dispose();
    }
  });
});

const documents = (stdout: string): unknown => JSON.parse(stdout);

describe("--json", () => {
  it("prints one error document for a usage error", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("json-usage")) });
    try {
      for (const line of [["backup", "verify", "--json"], ["status", "--json", "--env"], ["status", "--json", "--bogus"]]) {
        const outcome = await h.run(line);
        expect(outcome.code, line.join(" ")).toBe(2);
        expect(documents(outcome.stdout), line.join(" ")).toMatchObject({ schema: "kestrel-ops/error@1", ok: false });
      }
    } finally {
      await h.dispose();
    }
  });

  it("prints only the result document when the end entry of the journal cannot be written after a backup", async () => {
    const inner = memoryStore(new MemoryBucket("json-run-done"));
    let failRunDone = false;
    const store: ObjectStore = { ...inner, put: async (key, data, options) => (failRunDone && key.endsWith("-run-done-done.json") ? Promise.reject(new Error(`connection reset writing ${key}`)) : inner.put(key, data, options)) };
    const h = createHarness({ store });
    try {
      await h.app.start();
      await h.app.seed();
      failRunDone = true;
      const created = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(created.code).toBe(0);
      expect(documents(created.stdout)).toMatchObject({ schema: "kestrel-ops/backup-create@1", ok: true });
      expect(created.stderr).toContain("run-done-done.json");
    } finally {
      await h.dispose();
    }
  });

  it("names the written backup in the error document when the app does not become ready after a frozen backup", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("json-not-ready")) });
    try {
      await h.app.start();
      await h.app.seed();
      const waitReady = h.app.waitReady.bind(h.app);
      h.app.waitReady = async () => false;
      const created = await h.run(["backup", "create", "--freeze", "--json"]);
      h.app.waitReady = waitReady;
      expect(created.code).toBe(1);
      const doc = documents(created.stdout);
      expect(doc).toMatchObject({ schema: "kestrel-ops/error@1", ok: false });
      const listed = await h.run(["backup", "list", "--json"]);
      const id = String(Reflect.get(Object(Reflect.get(Object(listed.json.backups), 0)), "id"));
      expect(id).toMatch(/^prod-\d{8}T\d{6}Z-manual-[0-9a-f]{4}$/);
      expect(doc).toMatchObject({ backupId: id });
      expect(created.stderr).toContain(`backup ${id} is written and verified`);
    } finally {
      await h.dispose();
    }
  });
});

describe("backup verify", () => {
  it("writes nothing under an id the backup location does not hold", async () => {
    const bucket = new MemoryBucket("verify-unknown");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const created = await h.run(["backup", "create", "--json"]);
      const typo = `${String(created.json.id).slice(0, -4)}ffff`;
      const verified = await h.run(["backup", "verify", typo]);
      expect(verified.code).toBe(1);
      expect(verified.stderr).toContain(`backup ${typo} does not exist`);
      expect([...bucket.objects.keys()].filter((key) => key.includes(typo))).toEqual([]);
      const listed = await h.run(["backup", "list", "--json"]);
      expect(Array.isArray(listed.json.backups) ? listed.json.backups.length : 0).toBe(1);
    } finally {
      await h.dispose();
    }
  });
});
