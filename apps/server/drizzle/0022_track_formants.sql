ALTER TABLE `tracks` ADD `formant_mode` text;--> statement-breakpoint
ALTER TABLE `tracks` ADD `formant_shift` integer DEFAULT 0 NOT NULL;