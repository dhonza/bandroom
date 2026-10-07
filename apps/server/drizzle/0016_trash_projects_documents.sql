ALTER TABLE `projects` ADD `deleted_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `documents` ADD `deleted_by` text REFERENCES users(id);--> statement-breakpoint
UPDATE `projects` SET `deleted_by` = (SELECT e.`actor_user_id` FROM `events` e WHERE e.`action` = 'project.deleted' AND e.`target_id` = `projects`.`id` AND e.`actor_user_id` IN (SELECT `id` FROM `users`) ORDER BY e.`ts` DESC LIMIT 1) WHERE `deleted_at` IS NOT NULL;--> statement-breakpoint
UPDATE `documents` SET `deleted_by` = (SELECT e.`actor_user_id` FROM `events` e WHERE e.`action` = 'document.deleted' AND e.`target_id` = `documents`.`id` AND e.`actor_user_id` IN (SELECT `id` FROM `users`) ORDER BY e.`ts` DESC LIMIT 1) WHERE `deleted_at` IS NOT NULL;
