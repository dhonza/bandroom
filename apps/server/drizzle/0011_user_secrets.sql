CREATE TABLE `user_secrets` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`secret_enc` text NOT NULL,
	`last4` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `kind`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
