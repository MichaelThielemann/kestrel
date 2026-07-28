CREATE TABLE `publish_status` (
	`route` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`target` text NOT NULL,
	`updated_at` integer NOT NULL
);
