CREATE TABLE `media` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`storage_key` text NOT NULL,
	`folder` text,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`ext` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`checksum` text,
	`thumbhash` text,
	`derivatives` text DEFAULT '{}' NOT NULL,
	`translations` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `media_storage_key_unique` ON `media` (`storage_key`);