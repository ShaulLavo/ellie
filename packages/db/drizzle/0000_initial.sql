CREATE TABLE `sessions` (
  `id`          TEXT PRIMARY KEY NOT NULL,
  `created_at`  INTEGER NOT NULL,
  `updated_at`  INTEGER NOT NULL,
  `current_seq` INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `events` (
  `id`          INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `session_id`  TEXT NOT NULL REFERENCES `sessions`(`id`) ON DELETE CASCADE,
  `seq`         INTEGER NOT NULL,
  `run_id`      TEXT,
  `type`        TEXT NOT NULL,
  `payload`     TEXT NOT NULL,
  `dedupe_key`  TEXT,
  `created_at`  INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_session_seq`
  ON `events`(`session_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `idx_events_session_type`
  ON `events`(`session_id`, `type`);
--> statement-breakpoint
CREATE INDEX `idx_events_session_run_seq`
  ON `events`(`session_id`, `run_id`, `seq`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_events_session_dedupe`
  ON `events`(`session_id`, `dedupe_key`)
  WHERE `dedupe_key` IS NOT NULL;
