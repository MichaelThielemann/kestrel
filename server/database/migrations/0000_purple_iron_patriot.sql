CREATE TABLE `pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`locale` text NOT NULL,
	`translation_group` text NOT NULL,
	`path` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`seo` text DEFAULT '{}' NOT NULL,
	`content` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_group_locale` ON `pages` (`translation_group`,`locale`);--> statement-breakpoint
CREATE UNIQUE INDEX `pages_path_locale` ON `pages` (`path`,`locale`) WHERE path is not null;--> statement-breakpoint
CREATE INDEX `pages_group` ON `pages` (`translation_group`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`locale` text NOT NULL,
	`translation_group` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_group_locale` ON `posts` (`translation_group`,`locale`);--> statement-breakpoint
CREATE INDEX `posts_group` ON `posts` (`translation_group`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`singleton_key` text NOT NULL,
	`locale` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `settings_key_locale` ON `settings` (`singleton_key`,`locale`);