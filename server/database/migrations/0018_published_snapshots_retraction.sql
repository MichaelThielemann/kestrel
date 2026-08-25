-- Retraction (unpublish): `retracted_at` is additive and nullable, set-once-from-NULL like `superseded_by`.
-- History stays immutable — retracting does NOT set `superseded_by` (the supersede chain is untouched);
-- it only hides the row from the delivery-facing "current" read (`currentSnapshot`/`currentRoutes`, both
-- narrowed to `retracted_at IS NULL`). A later republish of the same route creates a NEW row on top of the
-- chain, exactly like any other content change — the retracted row simply becomes non-head history.
ALTER TABLE `published_snapshots` ADD `retracted_at` integer;
--> statement-breakpoint
-- Re-declared to also cover `retracted_at`, matching `layers/public/server/db/snapshots.ts`'s table
-- definition — the current-lookup query now filters on all three columns.
DROP INDEX IF EXISTS `published_snapshots_route`;
--> statement-breakpoint
CREATE INDEX `published_snapshots_route` ON `published_snapshots` (`route`,`superseded_by`,`retracted_at`);
--> statement-breakpoint
CREATE TRIGGER `published_snapshots_retract_once`
BEFORE UPDATE OF `retracted_at` ON `published_snapshots`
WHEN OLD.`retracted_at` IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'published_snapshots.retracted_at can only be set once, from NULL');
END;
