CREATE TABLE `publish_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `publish_runs_status` ON `publish_runs` (`status`,`id`);
