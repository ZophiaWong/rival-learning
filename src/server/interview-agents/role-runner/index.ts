import { z } from "zod";

import type { ProviderId, RoleName } from "@/server/config/server-config";

export type AgentRole = RoleName;
export type { ProviderId };

export interface RoleRunRequest<T> {
  role: AgentRole;
  operation: string;
  instructions: string;
  input: string;
  outputSchema: z.ZodType<T>;
  signal?: AbortSignal;
  onOutputDelta?: (delta: string) => void | Promise<void>;
}

export type ModelAttemptOutcome =
  | "succeeded"
  | "network_error"
  | "timeout"
  | "http_error"
  | "schema_invalid"
  | "aborted"
  | "stream_interrupted"
  | "internal_error";

export interface ModelAttempt {
  attempt: number;
  providerId: ProviderId;
  model: string;
  outcome: ModelAttemptOutcome;
  httpStatus: number | null;
  requestId: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface RoleRunUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  usageComplete: boolean;
}

export type RoleRunErrorCode =
  | "provider_not_configured"
  | "provider_unsupported"
  | "provider_auth_failed"
  | "provider_quota_exhausted"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_rejected"
  | "model_not_found"
  | "schema_invalid"
  | "aborted"
  | "stream_interrupted"
  | "internal_error";

export type RoleRunResult<T> =
  | {
      status: "success";
      value: T;
      attempts: ModelAttempt[];
      usage: RoleRunUsage;
    }
  | {
      status: "failure";
      error: {
        code: RoleRunErrorCode;
        message: string;
      };
      attempts: ModelAttempt[];
      usage: RoleRunUsage;
    };

export interface RoleRunner {
  runStructured<T>(request: RoleRunRequest<T>): Promise<RoleRunResult<T>>;
}

export function aggregateRoleRunUsage(attempts: ModelAttempt[]): RoleRunUsage {
  return {
    requests: attempts.length,
    inputTokens: attempts.reduce((total, attempt) => total + (attempt.inputTokens ?? 0), 0),
    outputTokens: attempts.reduce((total, attempt) => total + (attempt.outputTokens ?? 0), 0),
    usageComplete: attempts.every(
      (attempt) => attempt.inputTokens !== null && attempt.outputTokens !== null,
    ),
  };
}

export const abortedRoleRunResult = (): RoleRunResult<never> => ({
  status: "failure",
  error: { code: "aborted", message: "The model request was aborted." },
  attempts: [],
  usage: {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    usageComplete: true,
  },
});
