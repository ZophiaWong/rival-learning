import { z } from "zod";

import {
  attackChainExecutionStateSchema,
  generationMetadataSchema,
  interviewLanguageSchema,
  interviewPlanRecordSchema,
  publicQuestionTurnSchema,
} from "@/server/core-loop/domain";
import { coreLoopPolicySchema } from "@/server/core-loop/policy";

export const sessionPhaseSchema = z.enum(["draft", "planned", "active", "error"]);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

export const sessionOperationSchema = z.enum([
  "generate_plan",
  "start",
  "request_ai_answer",
  "request_next_question",
]);
export type SessionOperation = z.infer<typeof sessionOperationSchema>;

export const activeOperationSchema = z.strictObject({
  type: sessionOperationSchema,
  token: z.string().min(1),
  priorPhase: sessionPhaseSchema.exclude(["error"]),
  startedAt: z.iso.datetime(),
});

export const failedOperationSchema = z.strictObject({
  type: sessionOperationSchema,
  priorPhase: sessionPhaseSchema.exclude(["error"]),
  operationToken: z.string().min(1),
  code: z.string().min(1),
  userMessage: z.string().min(1),
  retrySafety: z.enum(["safe_to_retry", "manual_review"]),
  rejectionCounts: z.record(z.string(), z.number().int().min(1)),
  lastRejectionReason: z.string().min(1).nullable(),
  generation: generationMetadataSchema,
});
export type FailedOperation = z.infer<typeof failedOperationSchema>;

export const sessionStateV3Schema = z.strictObject({
  stateVersion: z.literal(3),
  phase: sessionPhaseSchema,
  interviewLanguage: interviewLanguageSchema,
  policy: coreLoopPolicySchema,
  planRecord: interviewPlanRecordSchema.nullable(),
  execution: attackChainExecutionStateSchema.nullable(),
  activeOperation: activeOperationSchema.nullable(),
  failedOperation: failedOperationSchema.nullable(),
});
export type SessionStateV3 = z.infer<typeof sessionStateV3Schema>;

export interface PublicSessionState {
  interviewLanguage: SessionStateV3["interviewLanguage"];
  plan: NonNullable<SessionStateV3["planRecord"]>["plan"] | null;
  execution: {
    chainId: string;
    answerMode: NonNullable<SessionStateV3["execution"]>["answerMode"];
    status: NonNullable<SessionStateV3["execution"]>["status"];
    turns: Array<z.infer<typeof publicQuestionTurnSchema>>;
    completion: NonNullable<SessionStateV3["execution"]>["completion"];
  } | null;
  activeOperation: SessionOperation | null;
  failedOperation: Omit<FailedOperation, "operationToken" | "generation"> | null;
}

export function projectSessionState(state: SessionStateV3): PublicSessionState {
  return {
    interviewLanguage: state.interviewLanguage,
    plan: state.planRecord?.plan ?? null,
    execution: state.execution
      ? {
          chainId: state.execution.chainId,
          answerMode: state.execution.answerMode,
          status: state.execution.status,
          turns: state.execution.turns.map((turn) => publicQuestionTurnSchema.parse(turn)),
          completion: state.execution.completion,
        }
      : null,
    activeOperation: state.activeOperation?.type ?? null,
    failedOperation: state.failedOperation
      ? {
          type: state.failedOperation.type,
          priorPhase: state.failedOperation.priorPhase,
          code: state.failedOperation.code,
          userMessage: state.failedOperation.userMessage,
          retrySafety: state.failedOperation.retrySafety,
          rejectionCounts: state.failedOperation.rejectionCounts,
          lastRejectionReason: state.failedOperation.lastRejectionReason,
        }
      : null,
  };
}
