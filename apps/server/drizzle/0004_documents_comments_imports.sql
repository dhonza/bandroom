CREATE TABLE `comment_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`user_id` text,
	`link_session_id` text,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `comment_reactions_user_idx` ON `comment_reactions` (`comment_id`,`user_id`,`emoji`) WHERE "comment_reactions"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`track_id` text,
	`parent_id` text,
	`author_user_id` text,
	`link_id` text,
	`anonymous_name` text,
	`imported_author_name` text,
	`body` text NOT NULL,
	`start_sec` real,
	`end_sec` real,
	`context` text DEFAULT '{}' NOT NULL,
	`source` text DEFAULT 'app' NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `comments_song_idx` ON `comments` (`song_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `comments_parent_idx` ON `comments` (`parent_id`);--> statement-breakpoint
CREATE TABLE `document_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`number` integer NOT NULL,
	`asset_id` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'upload' NOT NULL,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `document_versions_doc_idx` ON `document_versions` (`document_id`,`number`);--> statement-breakpoint
CREATE INDEX `document_versions_asset_idx` ON `document_versions` (`asset_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`song_id` text,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`current_version_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `documents_project_idx` ON `documents` (`project_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `documents_song_idx` ON `documents` (`song_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `import_map` (
	`source` text NOT NULL,
	`external_type` text NOT NULL,
	`external_id` text NOT NULL,
	`local_type` text NOT NULL,
	`local_id` text NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`source`, `external_type`, `external_id`, `local_type`),
	FOREIGN KEY (`run_id`) REFERENCES `import_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_map_local_idx` ON `import_map` (`local_type`,`local_id`);--> statement-breakpoint
CREATE TABLE `import_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`dry_run` integer DEFAULT false NOT NULL,
	`secret_enc` text,
	`selection` text DEFAULT '[]' NOT NULL,
	`mapping` text,
	`report` text,
	`progress` real DEFAULT 0 NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `import_runs_created_idx` ON `import_runs` (`created_at`);