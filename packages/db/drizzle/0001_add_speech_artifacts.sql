CREATE TABLE IF NOT EXISTS `speech_artifacts` (
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
	`claimed_by_session_id` text,
	`claimed_by_event_id` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_speech_status` ON `speech_artifacts` (`status`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_speech_expires` ON `speech_artifacts` (`expires_at`);
