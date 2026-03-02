CREATE TABLE IF NOT EXISTS `agent_bootstrap_state` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workspace_seeded_at` integer,
	`bootstrap_injected_at` integer,
	`bootstrap_injected_session_id` text,
	`onboarding_completed_at` integer,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`run_id` text,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`dedupe_key` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_events_session_seq` ON `events` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_session_type` ON `events` (`session_id`,`type`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_events_session_run_seq` ON `events` (`session_id`,`run_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_events_session_dedupe` ON `events` (`session_id`,`dedupe_key`) WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`current_seq` integer DEFAULT 0 NOT NULL
);
