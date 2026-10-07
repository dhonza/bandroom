CREATE TABLE `markers` (
	`id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`start_sec` real NOT NULL,
	`end_sec` real,
	`anchor` text DEFAULT 'time' NOT NULL,
	`start_beat` real,
	`end_beat` real,
	`lane` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `markers_song_idx` ON `markers` (`song_id`,`start_sec`);--> statement-breakpoint
CREATE TABLE `song_visits` (
	`user_id` text NOT NULL,
	`song_id` text NOT NULL,
	`last_visited_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `song_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
