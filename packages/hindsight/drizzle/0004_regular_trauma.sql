CREATE TABLE `hs_visual_access_history` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`visual_memory_id` text NOT NULL,
	`accessed_at` integer NOT NULL,
	`session_id` text,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`visual_memory_id`) REFERENCES `hs_visual_memories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_vah_bank_visual` ON `hs_visual_access_history` (`bank_id`,`visual_memory_id`,"accessed_at" desc);--> statement-breakpoint
CREATE TABLE `hs_visual_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_id` text NOT NULL,
	`source_id` text,
	`description` text NOT NULL,
	`scope_profile` text,
	`scope_project` text,
	`scope_session` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_vm_bank_created` ON `hs_visual_memories` (`bank_id`,"created_at" desc);--> statement-breakpoint
CREATE INDEX `idx_hs_vm_bank_scope` ON `hs_visual_memories` (`bank_id`,`scope_project`,"created_at" desc);