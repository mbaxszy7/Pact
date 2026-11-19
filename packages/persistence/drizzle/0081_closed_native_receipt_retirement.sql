CREATE TABLE `scheduling_physical_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`runtime_owner_id` text NOT NULL,
	`native_generation` integer NOT NULL,
	`witness_json` text NOT NULL,
	`state` text NOT NULL,
	`entry_bytes` integer NOT NULL,
	FOREIGN KEY (`runtime_owner_id`) REFERENCES `scheduling_runtime_owners`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_physical_receipts_generation` ON `scheduling_physical_receipts` (`runtime_owner_id`,`native_generation`);