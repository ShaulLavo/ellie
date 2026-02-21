CREATE TABLE `schema_registry` (
	`key` text PRIMARY KEY NOT NULL,
	`json_schema` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `streams` ADD `schema_key` text;