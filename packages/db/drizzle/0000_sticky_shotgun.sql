CREATE TABLE `agent_bootstrap_state` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workspace_seeded_at` integer,
	`bootstrap_injected_at` integer,
	`bootstrap_injected_branch_id` text,
	`onboarding_completed_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`parent_branch_id` text,
	`forked_from_event_id` integer,
	`forked_from_seq` integer,
	`current_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`branch_id` text NOT NULL,
	`seq` integer NOT NULL,
	`run_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_branch_seq` ON `events` (`branch_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_events_branch_type` ON `events` (`branch_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_events_branch_run_seq` ON `events` (`branch_id`,`run_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_branch_dedupe` ON `events` (`branch_id`,`dedupe_key`) WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE TABLE `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `speech_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`blob_path` text NOT NULL,
	`source` text NOT NULL,
	`flow` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`normalized_by` text NOT NULL,
	`transcript_text` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`speech_detected` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`claimed_at` integer,
	`claimed_by_branch_id` text,
	`claimed_by_event_id` integer
);
--> statement-breakpoint
CREATE INDEX `idx_speech_status` ON `speech_artifacts` (`status`);--> statement-breakpoint
CREATE INDEX `idx_speech_expires` ON `speech_artifacts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `thread_channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`account_id` text NOT NULL,
	`conversation_key` text NOT NULL,
	`attached_at` integer NOT NULL,
	`detached_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_thread_channels_active` ON `thread_channels` (`channel_id`,`account_id`,`conversation_key`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`agent_type` text NOT NULL,
	`workspace_id` text NOT NULL,
	`title` text,
	`state` text DEFAULT 'active' NOT NULL,
	`day_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
