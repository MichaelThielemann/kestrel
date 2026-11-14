import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createHarness, LOCATION, PREFIXES, SECRETS } from "./harness.fixture.ts";
import { fromJsonl, keys } from "./layout.ts";
import type { BlobEntry, SiteEntry } from "./layout.ts";
import type { ObjectStore } from "./store.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function backupRows(data: Uint8Array): Record<string, unknown[]> {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-ops-rows-"));
  try {
    const file = join(dir, "db.sqlite");
    writeFileSync(file, data);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const out: Record<string, unknown[]> = {};
      for (const table of ["pages", "media_items", "authn_users", "audit_entries", "mfa_factors", "authn_sessions"]) out[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY "id"`).all();
      return out;
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const parseLines = <T>(data: Uint8Array | null): T[] => boundaryCast<T[]>(fromJsonl(data ?? new Uint8Array()), "json");

/**
 * The end-to-end backup and restore round trip against a store: seed, frozen backup, verify, mutate (delete an
 * original, change and add pages, upload, export again), restore, then a second restore that changes nothing.
 */
export function backupRestoreRoundTrip(makeStore: () => Promise<ObjectStore>): void {
  it("restores rows, originals and the delivery prefix of a frozen backup, keeps newer uploads, and a second restore is a no-op", async () => {
    const store = await makeStore();
    const h = createHarness({ store });
    try {
      await h.app.start();
      await h.app.seed();

      const created = await h.run(["backup", "create", "--freeze", "--env", "prod", "--json"]);
      expect(created.stderr).toBe("");
      expect(created.code).toBe(0);
      const id = String(created.json.id);
      expect(created.json.manifest).toMatchObject({ kind: "manual", frozen: true, source: { seal: "sealed" }, blobs: { count: 3, missingAtBackup: [] }, site: { count: 4 } });
      expect((await h.app.status()).state).toBe("started");

      expect((await h.run(["backup", "verify", id])).code).toBe(0);

      await h.app.deleteMedia("m1");
      h.app.run(`UPDATE pages SET "title" = 'About us' WHERE "id" = 'about'`);
      h.app.run(`INSERT INTO pages VALUES ('news', 'News', 'Fresh')`);
      h.app.run(`DELETE FROM pages WHERE "id" = 'contact'`);
      const newer = await h.app.upload("m4", "later.png", encode("uploaded after the backup"));
      h.app.run(`INSERT INTO authn_sessions VALUES ('s2', 'u2', 9999999999999, 2)`);
      await h.app.export();
      await h.app.sync();

      const restored = await h.run(["restore", "--backup", id, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      expect(restored.stderr).toBe("");
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ noop: false, originalsRestored: [`${PREFIXES.media}m1/harbour.jpg`], newerOriginals: [newer], acknowledgement: "applied", sessionsDeleted: 1 });
      expect(String(restored.json.safetyBackup)).toMatch(/^prod-\d{8}T\d{6}Z-pre-restore-[0-9a-f]{4}$/);

      const db = await store.get(LOCATION + keys.db(id));
      const expected = backupRows(db ?? new Uint8Array());
      for (const table of ["pages", "media_items", "authn_users", "audit_entries", "mfa_factors"]) expect(h.app.rows(table), table).toEqual(expected[table]);
      expect(h.app.rows("authn_sessions")).toEqual([]);

      const blobs = parseLines<BlobEntry>(await store.get(LOCATION + keys.blobs(id)));
      for (const entry of blobs) expect((await store.head(entry.key))?.etag, entry.key).toBe(entry.etag);
      expect(await store.head(newer)).not.toBeNull();
      const site = parseLines<SiteEntry>(await store.get(LOCATION + keys.site(id)));
      const live = await store.list(PREFIXES.delivery);
      expect(live.map((i) => [i.key, i.etag, i.size])).toEqual(site.map((s) => [s.key, s.etag, s.size]));
      for (const entry of site) expect(new TextDecoder().decode((await store.get(entry.key)) ?? new Uint8Array())).toBe(new TextDecoder().decode((await store.get(LOCATION + entry.object)) ?? new Uint8Array()));

      const again = await h.run(["restore", "--backup", id, "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      expect(again.code).toBe(0);
      expect(again.json).toMatchObject({ noop: true, originalsRestored: [], delivery: { written: [], removed: [] }, safetyBackup: null, promoted: null });
      expect((await h.app.status()).state).toBe("started");

      for (const text of h.outputs) {
        expect(text).not.toContain(SECRETS.accessKeyId);
        expect(text).not.toContain(SECRETS.secretAccessKey);
      }
      for (const info of await store.list(LOCATION)) {
        if (info.key.endsWith(".sqlite") || info.key.includes("/objects/") || info.key.startsWith(`${LOCATION}objects/`)) continue;
        const text = new TextDecoder().decode((await store.get(info.key)) ?? new Uint8Array());
        expect(text, info.key).not.toContain(SECRETS.accessKeyId);
        expect(text, info.key).not.toContain(SECRETS.secretAccessKey);
        expect(info.key).not.toContain(".instance");
      }
    } finally {
      await h.dispose();
    }
  });
}
