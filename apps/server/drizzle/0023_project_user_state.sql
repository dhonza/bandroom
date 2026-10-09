CREATE TABLE `project_user_state` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`starred_at` integer,
	`last_accessed_at` integer,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
