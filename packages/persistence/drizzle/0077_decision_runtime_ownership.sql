ALTER TABLE `scheduling_evaluations` ADD `physical_witness_json` text;--> statement-breakpoint
ALTER TABLE `scheduling_settings` ADD `configuration_generation` integer DEFAULT 0 NOT NULL;