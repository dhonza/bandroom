CREATE TABLE `asset_variants` (
	`asset_id` text NOT NULL,
	`variant` text NOT NULL,
	`blob_hash` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `variant`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blob_hash`) REFERENCES `blobs`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `asset_variants_blob_idx` ON `asset_variants` (`blob_hash`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`original_filename` text NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` integer NOT NULL,
	`original_hash` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`probe` text,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `assets_uploader_idx` ON `assets` (`uploaded_by`);--> statement-breakpoint
CREATE TABLE `blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`size_bytes` integer NOT NULL,
	`backend` text DEFAULT 'local' NOT NULL,
	`storage_key` text NOT NULL,
	`ref_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`unreferenced_at` integer
);
--> statement-breakpoint
CREATE INDEX `blobs_gc_idx` ON `blobs` (`ref_count`,`unreferenced_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`capability` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`locked_by` text,
	`locked_until` integer,
	`run_after` integer DEFAULT 0 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`result` text,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`dedupe_key` text
);
--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`capability`,`priority`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_active_idx` ON `jobs` (`dedupe_key`) WHERE "jobs"."dedupe_key" IS NOT NULL AND "jobs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE TABLE `track_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`track_id` text NOT NULL,
	`number` integer NOT NULL,
	`stack_order` integer DEFAULT 0 NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`asset_id` text NOT NULL,
	`offset_samples` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`is_auto_mix` integer DEFAULT false NOT NULL,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `track_versions_track_idx` ON `track_versions` (`track_id`,`number`);--> statement-breakpoint
CREATE INDEX `track_versions_asset_idx` ON `track_versions` (`asset_id`);--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'track' NOT NULL,
	`color` text DEFAULT 'blue' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`current_version_id` text,
	`default_gain_db` real DEFAULT 0 NOT NULL,
	`default_pan` real DEFAULT 0 NOT NULL,
	`default_muted` integer DEFAULT false NOT NULL,
	`instrument_tag` text DEFAULT '' NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tracks_song_idx` ON `tracks` (`song_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target` text NOT NULL,
	`filename` text NOT NULL,
	`declared_size` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_usage` (
	`user_id` text PRIMARY KEY NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`last_seen_at` integer,
	`version` text
);
