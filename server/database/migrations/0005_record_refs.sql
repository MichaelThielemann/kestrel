CREATE TABLE `record_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_coll` text NOT NULL,
	`source_id` integer NOT NULL,
	`target_coll` text NOT NULL,
	`target_id` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `record_refs_source` ON `record_refs` (`source_coll`,`source_id`);--> statement-breakpoint
CREATE INDEX `record_refs_target` ON `record_refs` (`target_coll`,`target_id`);