ALTER TABLE `posts` ADD `path` text;--> statement-breakpoint
CREATE UNIQUE INDEX `posts_path_locale` ON `posts` (`path`,`locale`) WHERE path is not null;