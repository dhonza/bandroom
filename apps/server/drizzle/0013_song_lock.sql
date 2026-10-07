ALTER TABLE `songs` ADD `locked_at` integer;--> statement-breakpoint
ALTER TABLE `songs` ADD `locked_by` text REFERENCES users(id);