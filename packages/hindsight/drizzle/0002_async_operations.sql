CREATE TABLE `hs_async_operations` (
  `operation_id` text PRIMARY KEY NOT NULL,
  `bank_id` text NOT NULL,
  `operation_type` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending',
  `result_metadata` text,
  `error_message` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`bank_id`) REFERENCES `hs_banks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hs_ops_bank` ON `hs_async_operations` (`bank_id`);
--> statement-breakpoint
CREATE INDEX `idx_hs_ops_status` ON `hs_async_operations` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_hs_ops_bank_status` ON `hs_async_operations` (`bank_id`,`status`);
