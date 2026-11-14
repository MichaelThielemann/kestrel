import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCredential, withSecretFile } from "./credentials.ts";
import { createHarness, LOCATION, SECRETS } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { Redactor } from "./redact.ts";

const SRC = dirname(fileURLToPath(import.meta.url));

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("secrets", () => {
  it("never shows a known credential in stdout, stderr, the journal, the manifest, the report or the kept working directory", async () => {
    const bucket = new MemoryBucket("secrets");
    const store = memoryStore(bucket);
    const h = createHarness({ store });
    const commandSecret = "cmd-secret-9f8e7d-from-a-password-manager";
    try {
      const envFile = join(h.root, "kestrel.environments.json");
      writeFileSync(envFile, readFileSync(envFile, "utf8").replace('"secretAccessKey": {\n            "env": "OPS_SECRET_KEY"\n          }', '"secretAccessKey": { "command": ["pass", "show", "kestrel/ops"] }'));
      expect(readFileSync(envFile, "utf8")).toContain('"command"');
      const runCommand = async () => `${commandSecret}\n`;
      let failing = false;
      const stores = (): typeof store => {
        if (failing) throw new Error(`connection refused for key ${SECRETS.accessKeyId} with secret ${commandSecret}`);
        return store;
      };
      await h.app.start();
      await h.app.seed();
      h.app.run(`INSERT INTO pages VALUES ('leak', ?, 'body')`, `title mentioning ${commandSecret}`);
      await h.app.sync();
      const backup = await h.run(["backup", "create", "--freeze", "--json", "--keep"], { runCommand, stores });
      expect(backup.code).toBe(0);
      const restore = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json", "--keep"], { runCommand, stores });
      expect(restore.code).toBe(0);
      failing = true;
      const failed = await h.run(["status", "--json"], { runCommand, stores });
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain("connection refused for key [redacted] with secret [redacted]");

      const texts = [...h.outputs];
      for (const [key, object] of bucket.objects) if (key.startsWith(LOCATION) && !key.endsWith(".sqlite") && !key.startsWith(`${LOCATION}objects/`)) texts.push(new TextDecoder().decode(object.data));
      for (const file of filesUnder(join(h.root, "state"))) if (!file.endsWith(".db")) texts.push(readFileSync(file, "utf8"));
      expect(texts.length).toBeGreaterThan(20);
      for (const text of texts) {
        expect(text).not.toContain(SECRETS.accessKeyId);
        expect(text).not.toContain(commandSecret);
      }
    } finally {
      await h.dispose();
    }
  });

  it("masks a secret and its URL-encoded form, longest first, and ignores values too short to mask", () => {
    const redactor = new Redactor();
    redactor.add("a/b+c==secret");
    redactor.add("a/b");
    redactor.add("xyz");
    expect(redactor.apply("raw a/b+c==secret, encoded a%2Fb%2Bc%3D%3Dsecret, short xyz")).toBe("raw [redacted], encoded [redacted], short xyz");
  });

  it("resolves a credential from the environment or a command, and names neither the value nor the output when it fails", async () => {
    const redactor = new Redactor();
    expect(await resolveCredential({ env: "KEY" }, "prod.key", redactor, { KEY: "value-from-env" })).toBe("value-from-env");
    expect(await resolveCredential({ command: ["pass", "show", "x"] }, "prod.secret", redactor, {}, async () => "from-command-123\n")).toBe("from-command-123");
    expect(redactor.apply("from-command-123 value-from-env")).toBe("[redacted] [redacted]");
    await expect(resolveCredential({ env: "MISSING" }, "prod.key", redactor, {})).rejects.toThrow("prod.key: environment variable MISSING is not set");
    await expect(resolveCredential({ command: ["false"] }, "prod.secret", redactor, {})).rejects.toThrow(/prod\.secret: the command false failed \(exited with 1\)/);
  });

  it("hands a secret to a child process only as a 0600 file that is removed afterwards, also when the use fails", async () => {
    let seen = "";
    await withSecretFile("vars: secret", async (file) => {
      seen = file;
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toBe("vars: secret");
    });
    expect(existsSync(seen)).toBe(false);
    await expect(
      withSecretFile("x", async (file) => {
        seen = file;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });
});

describe("source", () => {
  it("names no host route, host environment variable or host output prefix", () => {
    const forbidden = ["/api/", "KESTREL_S3_", "KESTREL_DATA_DIR", "site/"];
    const sources = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".fixture.ts"));
    expect(sources.length).toBeGreaterThan(15);
    const hits = sources.flatMap((f) => forbidden.filter((term) => readFileSync(join(SRC, f), "utf8").includes(term)).map((term) => `${f}: ${term}`));
    expect(hits).toEqual([]);
  });

  it("spawns no external binary besides the configured app command", () => {
    const spawning = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".fixture.ts"))
      .filter((f) => readFileSync(join(SRC, f), "utf8").includes('from "node:child_process"'));
    expect(spawning.sort()).toEqual(["credentials.ts", "target.ts"]);
  });
});
