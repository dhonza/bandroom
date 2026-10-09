CREATE TABLE `edit_renders` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`output_key` text NOT NULL,
	`track_id` text NOT NULL,
	`range_id` text,
	`range_index` integer,
	`title` text NOT NULL,
	`song_title` text,
	`target_track_id` text,
	`target_song_id` text,
	`version_id` text,
	`asset_id` text,
	`status` text NOT NULL,
	`clips` text NOT NULL,
	`offset_samples` integer NOT NULL,
	`length_frames` integer NOT NULL,
	`lossy_source` integer DEFAULT false NOT NULL,
	`peak_db` real,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `edit_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `edit_renders_output_idx` ON `edit_renders` (`session_id`,`output_key`);--> statement-breakpoint
CREATE INDEX `edit_renders_asset_idx` ON `edit_renders` (`asset_id`);--> statement-breakpoint
ALTER TABLE `track_versions` ADD `edit_session_id` text;--> statement-breakpoint
CREATE INDEX `track_versions_edit_idx` ON `track_versions` (`edit_session_id`);