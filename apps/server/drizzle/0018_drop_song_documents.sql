-- Guard (SPEC §28.4): the server deletes song documents and releases their files before this
-- migration runs; this only catches a database migrated without that step.
DELETE FROM `document_versions` WHERE `document_id` IN (SELECT `id` FROM `documents` WHERE `song_id` IS NOT NULL);--> statement-breakpoint
DELETE FROM `documents` WHERE `song_id` IS NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`current_version_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_documents`("id", "project_id", "title", "kind", "current_version_id", "sort_order", "created_by", "created_at", "deleted_at", "deleted_by") SELECT "id", "project_id", "title", "kind", "current_version_id", "sort_order", "created_by", "created_at", "deleted_at", "deleted_by" FROM `documents`;--> statement-breakpoint
DROP TABLE `documents`;--> statement-breakpoint
ALTER TABLE `__new_documents` RENAME TO `documents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `documents_project_idx` ON `documents` (`project_id`,`sort_order`);