DELETE FROM `idempotency_results`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE json_valid(`state_json`) = 0 OR json_extract(`state_json`, '$.stateVersion') IS NULL
);
--> statement-breakpoint
DELETE FROM `session_timeline`
WHERE `session_id` IN (
  SELECT `id` FROM `sessions`
  WHERE json_valid(`state_json`) = 0 OR json_extract(`state_json`, '$.stateVersion') IS NULL
);
--> statement-breakpoint
DELETE FROM `sessions`
WHERE json_valid(`state_json`) = 0 OR json_extract(`state_json`, '$.stateVersion') IS NULL;
