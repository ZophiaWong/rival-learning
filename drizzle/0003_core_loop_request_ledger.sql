CREATE TABLE `model_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`operation_token` text NOT NULL,
	`usage_complete` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
WITH RECURSIVE
usages AS (
  SELECT session_id, sequence,
    coalesce(json_extract(payload_json, '$.generation.usage.requests'), json_extract(payload_json, '$.usage.requests'), 0) AS requests,
    coalesce(json_extract(payload_json, '$.generation.usage.inputTokens'), json_extract(payload_json, '$.usage.inputTokens'), 0) AS input_tokens,
    coalesce(json_extract(payload_json, '$.generation.usage.outputTokens'), json_extract(payload_json, '$.usage.outputTokens'), 0) AS output_tokens,
    coalesce(json_extract(payload_json, '$.generation.usage.usageComplete'), json_extract(payload_json, '$.usage.usageComplete'), 0) AS complete
  FROM session_timeline
), expanded AS (
  SELECT *, 1 AS ordinal FROM usages WHERE requests > 0
  UNION ALL SELECT session_id, sequence, requests, input_tokens, output_tokens, complete, ordinal + 1
  FROM expanded WHERE ordinal < requests
)
INSERT INTO model_requests (id, session_id, operation_token, input_tokens, output_tokens, usage_complete)
SELECT 'legacy:' || session_id || ':' || sequence || ':' || ordinal, session_id, 'legacy:' || sequence,
  CASE WHEN ordinal = 1 THEN input_tokens ELSE 0 END,
  CASE WHEN ordinal = 1 THEN output_tokens ELSE 0 END, complete
FROM expanded;
