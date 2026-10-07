ALTER TABLE `songs` ADD `deleted_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `track_versions` ADD `deleted_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `tracks` ADD `deleted_by` text REFERENCES users(id);--> statement-breakpoint
UPDATE `songs` SET `deleted_by` = (SELECT e.`actor_user_id` FROM `events` e WHERE e.`action` = 'song.deleted' AND e.`target_id` = `songs`.`id` AND e.`actor_user_id` IN (SELECT `id` FROM `users`) ORDER BY e.`ts` DESC LIMIT 1) WHERE `deleted_at` IS NOT NULL;--> statement-breakpoint
UPDATE `tracks` SET `deleted_by` = (SELECT e.`actor_user_id` FROM `events` e WHERE e.`action` = 'track.deleted' AND e.`target_id` = `tracks`.`id` AND e.`actor_user_id` IN (SELECT `id` FROM `users`) ORDER BY e.`ts` DESC LIMIT 1) WHERE `deleted_at` IS NOT NULL;--> statement-breakpoint
UPDATE `track_versions` SET `deleted_by` = (SELECT e.`actor_user_id` FROM `events` e WHERE e.`action` = 'version.deleted' AND e.`target_id` = `track_versions`.`id` AND e.`actor_user_id` IN (SELECT `id` FROM `users`) ORDER BY e.`ts` DESC LIMIT 1) WHERE `deleted_at` IS NOT NULL;
