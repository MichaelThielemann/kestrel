CREATE TABLE `outbox_content` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`envelope` text NOT NULL,
	`aggregate_key` text NOT NULL,
	`sequence` integer NOT NULL,
	`processed_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`dead` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_content_aggregate` ON `outbox_content` (`aggregate_key`,`sequence`);--> statement-breakpoint
CREATE INDEX `outbox_content_pending` ON `outbox_content` (`processed_at`,`dead`,`id`);
