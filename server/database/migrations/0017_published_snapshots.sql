CREATE TABLE `published_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`route` text NOT NULL,
	`payload` text NOT NULL,
	`fingerprint` text NOT NULL,
	`published_at` integer NOT NULL,
	`superseded_by` integer
);
--> statement-breakpoint
CREATE INDEX `published_snapshots_route` ON `published_snapshots` (`route`,`superseded_by`);
--> statement-breakpoint
-- Current-pointer invariant: at most one non-superseded row per route. Hand-authored alongside the table
-- because it is a partial index (the schema-render engine renders it fine; it lives here because the
-- table itself is hand-authored — see the triggers below for why).
CREATE UNIQUE INDEX `published_snapshots_route_current_unique` ON `published_snapshots` (`route`) WHERE superseded_by IS NULL;
--> statement-breakpoint
-- UPDATE-proof enforcement, hand-authored (the schema-render engine has no trigger concept). These
-- statements MUST stay in step with `layers/public/server/db/snapshots.ts`'s `TRIGGER_DDL` — that module
-- provisions the same triggers for a consumer layer whose table only ever comes from the schema engine
-- (which never reaches this migration file). Each protected column's `BEFORE UPDATE OF <col>` trigger
-- fires only when an UPDATE statement names that column in its SET list: a DELETE, or an
-- `INSERT OR REPLACE` (implemented by SQLite as DELETE + INSERT, never an UPDATE), is NOT blocked by any
-- of these — DELETE stays open deliberately, for a future retention pass over old superseded rows.
CREATE TRIGGER `published_snapshots_no_update_route`
BEFORE UPDATE OF `route` ON `published_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'published_snapshots.route cannot be UPDATEd (DELETE/INSERT OR REPLACE are unaffected)');
END;
--> statement-breakpoint
CREATE TRIGGER `published_snapshots_no_update_payload`
BEFORE UPDATE OF `payload` ON `published_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'published_snapshots.payload cannot be UPDATEd (DELETE/INSERT OR REPLACE are unaffected)');
END;
--> statement-breakpoint
CREATE TRIGGER `published_snapshots_no_update_fingerprint`
BEFORE UPDATE OF `fingerprint` ON `published_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'published_snapshots.fingerprint cannot be UPDATEd (DELETE/INSERT OR REPLACE are unaffected)');
END;
--> statement-breakpoint
CREATE TRIGGER `published_snapshots_no_update_published_at`
BEFORE UPDATE OF `published_at` ON `published_snapshots`
BEGIN
  SELECT RAISE(ABORT, 'published_snapshots.published_at cannot be UPDATEd (DELETE/INSERT OR REPLACE are unaffected)');
END;
--> statement-breakpoint
-- `superseded_by` is the one mutable pointer, and only from NULL, and never to its own id: a row already
-- superseded can never be re-pointed, and a row can never supersede itself.
CREATE TRIGGER `published_snapshots_supersede_once`
BEFORE UPDATE OF `superseded_by` ON `published_snapshots`
WHEN OLD.`superseded_by` IS NOT NULL OR NEW.`superseded_by` = NEW.`id`
BEGIN
  SELECT RAISE(ABORT, 'published_snapshots.superseded_by can only be set once, from NULL, and never to its own id');
END;
