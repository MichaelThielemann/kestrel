CREATE TABLE IF NOT EXISTS `media_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`singleton_key` text NOT NULL,
	`variants` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `media_settings_key` ON `media_settings` (`singleton_key`);