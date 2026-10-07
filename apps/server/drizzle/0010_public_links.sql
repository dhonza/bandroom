CREATE TABLE `link_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`anonymous_name` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	FOREIGN KEY (`link_id`) REFERENCES `public_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `link_sessions_link_idx` ON `link_sessions` (`link_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `public_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`token_sealed` text NOT NULL,
	`scope_type` text NOT NULL,
	`project_id` text NOT NULL,
	`song_id` text,
	`version_ids` text DEFAULT '[]' NOT NULL,
	`content` text NOT NULL,
	`versions` text NOT NULL,
	`password_hash` text,
	`expires_at` integer,
	`active` integer DEFAULT true NOT NULL,
	`revoked_at` integer,
	`allow_download` integer DEFAULT false NOT NULL,
	`allow_comments` integer DEFAULT false NOT NULL,
	`show_comments` integer DEFAULT false NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_links_token_hash_unique` ON `public_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `public_links_project_idx` ON `public_links` (`project_id`);--> statement-breakpoint
CREATE INDEX `public_links_song_idx` ON `public_links` (`song_id`);--> statement-breakpoint
CREATE INDEX `events_link_ts_idx` ON `events` (`link_id`,`ts`);