import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { environmentProblems, type Environment } from "./environments.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";

const env = (app: Partial<Environment["app"]>, backups = "kestrel-backups/"): Environment => ({
  production: true,
  target: { adapter: "fake" },
  storage: { bucket: "b", prefix: "" },
  app: { replicaPrefix: "database/", mediaPrefix: "media/", deliveryPrefix: "www/", derivedPrefixes: ["media-variants/"], media: { collection: "media_items", keyField: "key", checksumField: "checksum" }, ...app },
  backups: { prefix: backups, retention: { cutover: 5, scheduled: 14, manual: 10, "pre-restore": 5 } },
});

describe("environment checks", () => {
  it("flags app prefixes inside each other, derived prefixes included", () => {
    expect(environmentProblems(env({}))).toEqual([]);
    expect(environmentProblems(env({ derivedPrefixes: ["www/variants/"] }))).toEqual(["the delivery prefix www/ overlaps the derived prefix www/variants/"]);
    expect(environmentProblems(env({ derivedPrefixes: ["media/variants/"] }))).toEqual(["the media prefix media/ overlaps the derived prefix media/variants/"]);
    expect(environmentProblems(env({ mediaPrefix: "database/media/" }))).toEqual(["the replica prefix database/ overlaps the media prefix database/media/"]);
    expect(environmentProblems(env({}, "www/kestrel-backups/"))).toEqual(["the backup location www/kestrel-backups/ overlaps the app prefix www/"]);
  });

  it("refuses every writing command with exit 2 while the backup location lies inside an app prefix, and writes nothing", async () => {
    const bucket = new MemoryBucket("overlap");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const good = await h.run(["backup", "create", "--json"]);
      expect(good.code).toBe(0);
      const backupKeys = [...bucket.objects.keys()].filter((k) => k.startsWith(LOCATION));
      h.editEnvironments((file) => {
        const prod = file.environments.prod ?? {};
        prod.backups = { prefix: `${PREFIXES.delivery}${LOCATION}` };
      });
      const before = new Map([...bucket.objects].map(([k, o]) => [k, o.etag]));
      for (const args of [["backup", "create", "--freeze", "--yes"], ["backup", "verify", String(good.json.id)], ["backup", "prune", "--yes"], ["restore", "--backup", String(good.json.id), "--yes"]]) {
        const refused = await h.run(args);
        expect(refused.code, args.join(" ")).toBe(2);
        expect(refused.stderr, args.join(" ")).toContain(`the backup location ${PREFIXES.delivery}${LOCATION} overlaps the app prefix ${PREFIXES.delivery}`);
      }
      expect(new Map([...bucket.objects].map(([k, o]) => [k, o.etag]))).toEqual(before);
      expect([...bucket.objects.keys()].filter((k) => k.startsWith(LOCATION))).toEqual(backupKeys);
      expect((await h.app.status()).state).toBe("started");
      expect((await h.run(["status"])).code).toBe(1);
    } finally {
      await h.dispose();
    }
  });
});

describe("--answers", () => {
  it("reads a relative answers file from the directory the tool was called in, also when the environments file lies elsewhere, as in a bundle", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("answers-cwd")) });
    const caller = mkdtempSync(join(tmpdir(), "kestrel-ops-caller-"));
    const before = process.cwd();
    try {
      await h.app.start();
      await h.app.seed();
      writeFileSync(join(caller, "answers.json"), JSON.stringify({ "unsealed-stop": "accept" }));
      h.app.kill();
      process.chdir(caller);
      const run = await h.run(["backup", "create", "--freeze", "--answers", "answers.json", "--json"]);
      expect(run.stderr).not.toContain("ENOENT");
      expect(run.code).toBe(0);
    } finally {
      process.chdir(before);
      rmSync(caller, { recursive: true, force: true });
      await h.dispose();
    }
  });

  it("reports a missing or unreadable answers file as a configuration error with exit 2", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("answers-missing")) });
    try {
      const missing = await h.run(["backup", "list", "--answers", join(h.root, "nowhere.json")]);
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("--answers");
      writeFileSync(join(h.root, "broken.json"), "{ not json");
      const broken = await h.run(["backup", "list", "--answers", join(h.root, "broken.json")]);
      expect(broken.code).toBe(2);
      expect(broken.stderr).toContain("--answers");
    } finally {
      await h.dispose();
    }
  });
});

describe("app credentials", () => {
  it("resolves them only for status, so backup and restore run without them", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("app-credentials")) });
    try {
      h.editEnvironments((file) => {
        const app = file.environments.prod?.app;
        if (typeof app === "object" && app !== null) Reflect.set(app, "credentials", { accessKeyId: { env: "APP_ACCESS_KEY" }, secretAccessKey: { env: "APP_SECRET_KEY" } });
      });
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"]);
      expect(backup.stderr).toBe("");
      expect(backup.code).toBe(0);
      const list = await h.run(["backup", "list"]);
      expect(list.code).toBe(0);
      const status = await h.run(["status"]);
      expect(status.code).toBe(2);
      expect(status.stderr).toContain("environment variable APP_ACCESS_KEY is not set");
    } finally {
      await h.dispose();
    }
  });
});
