ALTER TABLE `hs_memory_units` ADD `access_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `hs_memory_units` ADD `last_accessed` integer;--> statement-breakpoint
ALTER TABLE `hs_memory_units` ADD `encoding_strength` real DEFAULT 1.0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_hs_mu_last_accessed` ON `hs_memory_units` (`bank_id`,`last_accessed`);--> statement-breakpoint
CREATE INDEX `idx_hs_mu_access_count` ON `hs_memory_units` (`bank_id`,`access_count`);
