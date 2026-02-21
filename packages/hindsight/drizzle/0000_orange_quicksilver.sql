CREATE TABLE `hs_async_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`operation_type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_metadata` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_ops_bank` ON `hs_async_operations` (`bank_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_ops_status` ON `hs_async_operations` (`status`);--> statement-breakpoint
CREATE INDEX `idx_hs_ops_bank_status` ON `hs_async_operations` (`bank_id`,`status`);--> statement-breakpoint
CREATE TABLE `hs_banks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`config` text,
	`disposition` text,
	`mission` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hs_banks_name_unique` ON `hs_banks` (`name`);--> statement-breakpoint
CREATE TABLE `hs_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`bank_id` text NOT NULL,
	`content` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `hs_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_chunk_bank` ON `hs_chunks` (`bank_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_chunk_doc` ON `hs_chunks` (`document_id`);--> statement-breakpoint
CREATE TABLE `hs_directives` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_dir_bank` ON `hs_directives` (`bank_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_dir_bank_active` ON `hs_directives` (`bank_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `hs_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`original_text` text,
	`content_hash` text,
	`metadata` text,
	`retain_params` text,
	`tags` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_doc_bank` ON `hs_documents` (`bank_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_doc_hash` ON `hs_documents` (`content_hash`);--> statement-breakpoint
CREATE TABLE `hs_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`name` text NOT NULL,
	`entity_type` text NOT NULL,
	`description` text,
	`metadata` text,
	`mention_count` integer DEFAULT 0 NOT NULL,
	`first_seen` integer NOT NULL,
	`last_updated` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_ent_bank_name` ON `hs_entities` (`bank_id`,`name`);--> statement-breakpoint
CREATE INDEX `idx_hs_ent_type` ON `hs_entities` (`bank_id`,`entity_type`);--> statement-breakpoint
CREATE TABLE `hs_entity_cooccurrences` (
	`bank_id` text NOT NULL,
	`entity_a` text NOT NULL,
	`entity_b` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`bank_id`, `entity_a`, `entity_b`),
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_a`) REFERENCES `hs_entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_b`) REFERENCES `hs_entities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "hs_cooc_canonical_order" CHECK(entity_a <= entity_b)
);
--> statement-breakpoint
CREATE INDEX `idx_hs_cooc_bank` ON `hs_entity_cooccurrences` (`bank_id`);--> statement-breakpoint
CREATE TABLE `hs_memory_entities` (
	`memory_id` text NOT NULL,
	`entity_id` text NOT NULL,
	PRIMARY KEY(`memory_id`, `entity_id`),
	FOREIGN KEY (`memory_id`) REFERENCES `hs_memory_units`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `hs_entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_me_entity` ON `hs_memory_entities` (`entity_id`);--> statement-breakpoint
CREATE TABLE `hs_memory_links` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`link_type` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `hs_memory_units`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `hs_memory_units`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_link_source` ON `hs_memory_links` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_link_target` ON `hs_memory_links` (`target_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_link_bank_type` ON `hs_memory_links` (`bank_id`,`link_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hs_link_edge` ON `hs_memory_links` (`source_id`,`target_id`,`link_type`);--> statement-breakpoint
CREATE TABLE `hs_memory_units` (
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_mu_bank` ON `hs_memory_units` (`bank_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_fact_type` ON `hs_memory_units` (`bank_id`,`fact_type`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_document` ON `hs_memory_units` (`bank_id`,`document_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_chunk` ON `hs_memory_units` (`chunk_id`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_event_date` ON `hs_memory_units` (`bank_id`,`event_date`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_occurred_range` ON `hs_memory_units` (`bank_id`,`occurred_start`,`occurred_end`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_mentioned_at` ON `hs_memory_units` (`bank_id`,`mentioned_at`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_consolidated` ON `hs_memory_units` (`bank_id`,`consolidated_at`);--> statement-breakpoint
CREATE TABLE `hs_mental_models` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`name` text NOT NULL,
	`source_query` text NOT NULL,
	`content` text,
	`source_memory_ids` text,
	`tags` text,
	`auto_refresh` integer DEFAULT 0 NOT NULL,
	`last_refreshed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_mm_bank` ON `hs_mental_models` (`bank_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hs_mm_bank_name` ON `hs_mental_models` (`bank_id`,`name`);