PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_idempotency_results` (
	`session_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`command_type` text NOT NULL,
	`command_fingerprint` text DEFAULT '' NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `idempotency_key`)
);
--> statement-breakpoint
INSERT INTO `__new_idempotency_results`("session_id", "idempotency_key", "command_type", "command_fingerprint", "result_json", "created_at") SELECT "session_id", "idempotency_key", "command_type", '', "result_json", "created_at" FROM `idempotency_results`;--> statement-breakpoint
DROP TABLE `idempotency_results`;--> statement-breakpoint
ALTER TABLE `__new_idempotency_results` RENAME TO `idempotency_results`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
