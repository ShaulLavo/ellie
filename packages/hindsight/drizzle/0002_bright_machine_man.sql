CREATE TABLE `hs_episode_events` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`bank_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`event_time` integer NOT NULL,
	`route` text NOT NULL,
	`profile` text,
	`project` text,
	`session` text,
	FOREIGN KEY (`episode_id`) REFERENCES `hs_episodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_id`) REFERENCES `hs_memory_units`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_ee_episode_time` ON `hs_episode_events` (`episode_id`,`event_time`);--> statement-breakpoint
CREATE INDEX `idx_hs_ee_bank_memory` ON `hs_episode_events` (`bank_id`,`memory_id`,`event_time` DESC);--> statement-breakpoint
CREATE TABLE `hs_episode_temporal_links` (
	`id` text PRIMARY KEY NOT NULL,
	`from_episode_id` text NOT NULL,
	`to_episode_id` text NOT NULL,
	`reason` text NOT NULL,
	`gap_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_episode_id`) REFERENCES `hs_episodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_episode_id`) REFERENCES `hs_episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_etl_from` ON `hs_episode_temporal_links` (`from_episode_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_etl_to` ON `hs_episode_temporal_links` (`to_episode_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hs_etl_edge` ON `hs_episode_temporal_links` (`from_episode_id`,`to_episode_id`);--> statement-breakpoint
CREATE TABLE `hs_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`profile` text,
	`project` text,
	`session` text,
	`start_at` integer NOT NULL,
	`end_at` integer,
	`last_event_at` integer NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`boundary_reason` text,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_ep_bank_last_event` ON `hs_episodes` (`bank_id`,`last_event_at` DESC);--> statement-breakpoint
CREATE INDEX `idx_hs_ep_scope` ON `hs_episodes` (`bank_id`,`profile`,`project`,`session`);--> statement-breakpoint
CREATE TABLE `hs_memory_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`version_no` integer NOT NULL,
	`content` text NOT NULL,
	`entities_json` text,
	`attributes_json` text,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`memory_id`) REFERENCES `hs_memory_units`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_mv_memory` ON `hs_memory_versions` (`memory_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_mv_bank` ON `hs_memory_versions` (`bank_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hs_mv_memory_version` ON `hs_memory_versions` (`memory_id`,`version_no`);--> statement-breakpoint
CREATE TABLE `hs_reconsolidation_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`candidate_memory_id` text,
	`applied_memory_id` text NOT NULL,
	`route` text NOT NULL,
	`candidate_score` real,
	`conflict_detected` integer DEFAULT 0 NOT NULL,
	`conflict_keys_json` text,
	`policy_version` text DEFAULT 'v1' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_rd_bank_created` ON `hs_reconsolidation_decisions` (`bank_id`,`created_at` DESC);--> statement-breakpoint
CREATE INDEX `idx_hs_rd_applied` ON `hs_reconsolidation_decisions` (`applied_memory_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_hs_memory_units` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`content` text NOT NULL,
	`fact_type` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`document_id` text,
	`chunk_id` text,
	`event_date` integer,
	`occurred_start` integer,
	`occurred_end` integer,
	`mentioned_at` integer,
	`metadata` text,
	`tags` text,
	`source_text` text,
	`consolidated_at` integer,
	`proof_count` integer DEFAULT 0 NOT NULL,
	`source_memory_ids` text,
	`history` text,
	`access_count` integer DEFAULT 0 NOT NULL,
	`last_accessed` integer,
	`encoding_strength` real DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "hs_mu_encoding_strength_range" CHECK(encoding_strength >= 0 AND encoding_strength <= 3.0)
);
--> statement-breakpoint
INSERT INTO `__new_hs_memory_units`("id", "bank_id", "content", "fact_type", "confidence", "document_id", "chunk_id", "event_date", "occurred_start", "occurred_end", "mentioned_at", "metadata", "tags", "source_text", "consolidated_at", "proof_count", "source_memory_ids", "history", "access_count", "last_accessed", "encoding_strength", "created_at", "updated_at") SELECT "id", "bank_id", "content", "fact_type", "confidence", "document_id", "chunk_id", "event_date", "occurred_start", "occurred_end", "mentioned_at", "metadata", "tags", "source_text", "consolidated_at", "proof_count", "source_memory_ids", "history", "access_count", "last_accessed", "encoding_strength", "created_at", "updated_at" FROM `hs_memory_units`;--> statement-breakpoint
DROP TABLE `hs_memory_units`;--> statement-breakpoint
ALTER TABLE `__new_hs_memory_units` RENAME TO `hs_memory_units`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_hs_mu_bank` ON `hs_memory_units` (`bank_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_fact_type` ON `hs_memory_units` (`bank_id`,`fact_type`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_document` ON `hs_memory_units` (`bank_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_chunk` ON `hs_memory_units` (`chunk_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_event_date` ON `hs_memory_units` (`bank_id`,`event_date`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_occurred_range` ON `hs_memory_units` (`bank_id`,`occurred_start`,`occurred_end`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_mentioned_at` ON `hs_memory_units` (`bank_id`,`mentioned_at`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_consolidated` ON `hs_memory_units` (`bank_id`,`consolidated_at`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_last_accessed` ON `hs_memory_units` (`bank_id`,`last_accessed`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_access_count` ON `hs_memory_units` (`bank_id`,`access_count`);
