CREATE TABLE `hs_location_access_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`path_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`session` text,
	`activity_type` text DEFAULT 'access' NOT NULL,
	`accessed_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`path_id`) REFERENCES `hs_location_paths`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_id`) REFERENCES `hs_memory_units`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_lac_path_time` ON `hs_location_access_contexts` (`bank_id`,`path_id`,"accessed_at" desc);--> statement-breakpoint
CREATE INDEX `idx_hs_lac_memory_time` ON `hs_location_access_contexts` (`bank_id`,`memory_id`,"accessed_at" desc);--> statement-breakpoint
CREATE TABLE `hs_location_associations` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`source_path_id` text NOT NULL,
	`related_path_id` text NOT NULL,
	`co_access_count` integer DEFAULT 1 NOT NULL,
	`strength` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_path_id`) REFERENCES `hs_location_paths`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_path_id`) REFERENCES `hs_location_paths`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hs_la_edge` ON `hs_location_associations` (`bank_id`,`source_path_id`,`related_path_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_la_source` ON `hs_location_associations` (`bank_id`,`source_path_id`);--> statement-breakpoint
CREATE TABLE `hs_location_paths` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`raw_path` text NOT NULL,
	`normalized_path` text NOT NULL,
	`profile` text DEFAULT 'default' NOT NULL,
	`project` text DEFAULT 'default' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hs_lp_unique` ON `hs_location_paths` (`bank_id`,`normalized_path`,`profile`,`project`);--> statement-breakpoint
CREATE INDEX `idx_hs_lp_bank_norm` ON `hs_location_paths` (`bank_id`,`normalized_path`);--> statement-breakpoint
DROP INDEX `idx_hs_ee_bank_memory`;--> statement-breakpoint
CREATE INDEX `idx_hs_ee_bank_memory` ON `hs_episode_events` (`bank_id`,`memory_id`,"event_time" desc);--> statement-breakpoint
DROP INDEX `idx_hs_ep_bank_last_event`;--> statement-breakpoint
CREATE INDEX `idx_hs_ep_bank_last_event` ON `hs_episodes` (`bank_id`,"last_event_at" desc);--> statement-breakpoint
DROP INDEX `idx_hs_rd_bank_created`;--> statement-breakpoint
CREATE INDEX `idx_hs_rd_bank_created` ON `hs_reconsolidation_decisions` (`bank_id`,"created_at" desc);--> statement-breakpoint
ALTER TABLE `hs_memory_units` ADD `gist` text;--> statement-breakpoint
ALTER TABLE `hs_memory_units` ADD `scope_profile` text;--> statement-breakpoint
ALTER TABLE `hs_memory_units` ADD `scope_project` text;--> statement-breakpoint
ALTER TABLE `hs_memory_units` ADD `scope_session` text;--> statement-breakpoint
CREATE INDEX `idx_hs_mu_scope` ON `hs_memory_units` (`bank_id`,`scope_profile`,`scope_project`);