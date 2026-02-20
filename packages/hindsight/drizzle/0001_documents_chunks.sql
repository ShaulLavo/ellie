ALTER TABLE `hs_memory_units` ADD COLUMN `document_id` text;
--> statement-breakpoint
ALTER TABLE `hs_memory_units` ADD COLUMN `chunk_id` text;
--> statement-breakpoint
CREATE INDEX `idx_hs_mu_document` ON `hs_memory_units` (`bank_id`,`document_id`);
--> statement-breakpoint
CREATE INDEX `idx_hs_mu_chunk` ON `hs_memory_units` (`chunk_id`);
--> statement-breakpoint
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
CREATE INDEX `idx_hs_doc_bank` ON `hs_documents` (`bank_id`);
--> statement-breakpoint
CREATE INDEX `idx_hs_doc_hash` ON `hs_documents` (`content_hash`);
--> statement-breakpoint
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
CREATE INDEX `idx_hs_chunk_bank` ON `hs_chunks` (`bank_id`);
--> statement-breakpoint
CREATE INDEX `idx_hs_chunk_doc` ON `hs_chunks` (`document_id`);
