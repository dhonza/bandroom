CREATE TABLE `tempo_map_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`source` text NOT NULL,
	`data` text NOT NULL,
	`midi_asset_id` text,
	`bar1_offset_sec` real DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`midi_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tempo_map_revisions_song_idx` ON `tempo_map_revisions` (`song_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tempo_maps` (
	`song_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`data` text NOT NULL,
	`midi_asset_id` text,
	`bar1_offset_sec` real DEFAULT 0 NOT NULL,
	`revision_id` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`midi_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
