CREATE TABLE `edit_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text NOT NULL,
	`owner_id` text NOT NULL,
	`owner_since` integer NOT NULL,
	`base` text NOT NULL,
	`ops` text DEFAULT '[]' NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`options` text NOT NULL,
	`rev` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`save_logged_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `edit_sessions_song_idx` ON `edit_sessions` (`song_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `edit_sessions_active_idx` ON `edit_sessions` (`song_id`) WHERE "edit_sessions"."status" IN ('open', 'applying');