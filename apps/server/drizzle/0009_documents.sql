ALTER TABLE `document_versions` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `doc_font_size` integer DEFAULT 18 NOT NULL;