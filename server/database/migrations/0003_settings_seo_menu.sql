PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`locale` text NOT NULL,
	`singleton_key` text NOT NULL,
	`site_name` text,
	`meta_title` text,
	`meta_description` text,
	`og_image_id` integer,
	`main_menu` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "locale", "singleton_key", "created_at", "updated_at") SELECT "id", "locale", "singleton_key", "created_at", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `settings_key_locale` ON `settings` (`singleton_key`,`locale`);