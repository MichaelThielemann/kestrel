CREATE TABLE `site` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`locale` text NOT NULL,
	`singleton_key` text NOT NULL,
	`base_title` text,
	`title_separator` text DEFAULT '|',
	`title_position` text DEFAULT 'after',
	`description` text,
	`image_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_key_locale` ON `site` (`singleton_key`,`locale`);