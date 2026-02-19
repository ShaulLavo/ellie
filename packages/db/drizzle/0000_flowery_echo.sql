CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stream_path` text NOT NULL,
	`byte_pos` integer NOT NULL,
	`length` integer NOT NULL,
	`offset` text NOT NULL,
	`timestamp` integer NOT NULL,
	FOREIGN KEY (`stream_path`) REFERENCES `streams`(`path`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_stream_offset` ON `messages` (`stream_path`,`offset`);--> statement-breakpoint
CREATE TABLE `producers` (
	`stream_path` text NOT NULL,
	`producer_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`last_seq` integer NOT NULL,
	`last_updated` integer NOT NULL,
	PRIMARY KEY(`stream_path`, `producer_id`),
	FOREIGN KEY (`stream_path`) REFERENCES `streams`(`path`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `streams` (
	`path` text PRIMARY KEY NOT NULL,
	`content_type` text,
	`ttl_seconds` integer,
	`expires_at` text,
	`created_at` integer NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`closed_by_producer_id` text,
	`closed_by_epoch` integer,
	`closed_by_seq` integer,
	`current_read_seq` integer DEFAULT 0 NOT NULL,
	`current_byte_offset` integer DEFAULT 0 NOT NULL
);
