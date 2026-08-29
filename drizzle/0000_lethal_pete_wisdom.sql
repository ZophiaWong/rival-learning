CREATE TABLE `idempotency_results` (
	`session_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`command_type` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `idempotency_key`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `preparation_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`resume` text DEFAULT '' NOT NULL,
	`project_notes` text DEFAULT '' NOT NULL,
	`job_description` text DEFAULT '' NOT NULL,
	`target_role` text NOT NULL,
	`target_level` text NOT NULL,
	`repo_path` text,
	`content_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_views` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`source_content_hash` text NOT NULL,
	`redaction_version` text NOT NULL,
	`content_json` text NOT NULL,
	`confirmed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `preparation_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_views_profile_content_version_unique` ON `provider_views` (`profile_id`,`source_content_hash`,`redaction_version`);--> statement-breakpoint
CREATE TABLE `session_timeline` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_timeline_session_sequence_unique` ON `session_timeline` (`session_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_profile_id` text,
	`profile_snapshot_json` text NOT NULL,
	`provider_view_json` text NOT NULL,
	`redaction_version` text NOT NULL,
	`status` text NOT NULL,
	`state_json` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`operation_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_profile_id`) REFERENCES `preparation_profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_operation_token_unique` ON `sessions` (`operation_token`);--> statement-breakpoint
CREATE TRIGGER `session_timeline_immutable`
BEFORE UPDATE ON `session_timeline`
BEGIN
  SELECT RAISE(ABORT, 'session timeline is immutable');
END;
