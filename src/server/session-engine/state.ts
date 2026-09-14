import { learningStateSchema, type LearningState } from "@/server/core-loop/learning";
import { z } from "zod";

import {
  attackChainExecutionStateSchema,
  benchmarkBatchSchema,
  checkpointSchema,
  generationMetadataSchema,
  interviewLanguageSchema,
  interviewPlanRecordSchema,
  publicQuestionTurnSchema,
  turnEvaluationSchema,
  type Checkpoint,
} from "@/server/core-loop/domain";
import { coreLoopPolicySchema } from "@/server/core-loop/policy";

export const sessionPhaseSchema = z.enum(["draft", "planned", "active", "error", "budget_paused"]);
export type SessionPhase = z.infer<typeof sessionPhaseSchema>;

export const sessionOperationSchema = z.enum([
  "generate_plan",
  "start",
  "request_ai_answer",
  "request_next_question",
  "generate_checkpoint",
  "prepare_rechallenge",
  "evaluate_rechallenge",
  "generate_hint",
]);
export type SessionOperation = z.infer<typeof sessionOperationSchema>;

export const checkpointStageSchema = z.enum([
  "evaluating",
  "benchmarking",
  "synthesizing",
]);
export type CheckpointStage = z.infer<typeof checkpointStageSchema>;

export const activeOperationSchema = z.strictObject({
  type: sessionOperationSchema,
  token: z.string().min(1),
  idempotencyKey: z.string().min(1).max(128),
  priorPhase: sessionPhaseSchema.exclude(["error", "budget_paused"]),
  startedAt: z.iso.datetime(),
});

export const failedOperationSchema = z.strictObject({
  type: sessionOperationSchema,
  priorPhase: sessionPhaseSchema.exclude(["error", "budget_paused"]),
  operationToken: z.string().min(1),
  code: z.string().min(1),
  userMessage: z.string().min(1),
  retrySafety: z.enum(["safe_to_retry", "manual_review"]),
  rejectionCounts: z.record(z.string(), z.number().int().min(1)),
  lastRejectionReason: z.string().min(1).nullable(),
  generation: generationMetadataSchema,
  stage: checkpointStageSchema.nullable().default(null),
});
export type FailedOperation = z.infer<typeof failedOperationSchema>;

export const checkpointWorkStateSchema = z
  .strictObject({
    status: z.enum(["evaluating", "benchmarking", "synthesizing", "completed"]),
    chainId: z.string().min(1),
    humanTurnIds: z.array(z.string().min(1)).min(1).max(4),
    evaluations: z.array(turnEvaluationSchema).max(4),
    benchmarkBatch: benchmarkBatchSchema.nullable(),
    result: checkpointSchema.nullable(),
    startedAt: z.iso.datetime(),
  })
  .superRefine((checkpoint, context) => {
    const evaluationTurnIds = checkpoint.evaluations.map((evaluation) => evaluation.turnId);
    const expectedEvaluationTurnIds = checkpoint.humanTurnIds.slice(
      0,
      checkpoint.evaluations.length,
    );
    const evaluationsComplete =
      checkpoint.evaluations.length === checkpoint.humanTurnIds.length;
    if (
      new Set(checkpoint.humanTurnIds).size !== checkpoint.humanTurnIds.length ||
      evaluationTurnIds.some(
        (turnId, index) => turnId !== expectedEvaluationTurnIds[index],
      )
    ) {
      context.addIssue({ code: "custom", message: "Checkpoint turn order must remain stable" });
    }
    if (
      checkpoint.status === "evaluating" &&
      (evaluationsComplete || checkpoint.benchmarkBatch !== null || checkpoint.result !== null)
    ) {
      context.addIssue({ code: "custom", message: "Evaluation stage must remain incomplete" });
    }
    if (
      checkpoint.status === "benchmarking" &&
      (!evaluationsComplete || checkpoint.benchmarkBatch !== null || checkpoint.result !== null)
    ) {
      context.addIssue({ code: "custom", message: "Benchmark stage requires all evaluations" });
    }
    if (
      checkpoint.status === "synthesizing" &&
      (!evaluationsComplete || checkpoint.benchmarkBatch === null || checkpoint.result !== null)
    ) {
      context.addIssue({ code: "custom", message: "Synthesis stage requires frozen artifacts" });
    }
    if (
      checkpoint.benchmarkBatch &&
      (checkpoint.benchmarkBatch.benchmarks.length !== checkpoint.humanTurnIds.length ||
        checkpoint.benchmarkBatch.benchmarks.some(
          (benchmark, index) => benchmark.turnId !== checkpoint.humanTurnIds[index],
        ))
    ) {
      context.addIssue({ code: "custom", message: "Benchmark turn order must remain stable" });
    }
    if (
      checkpoint.status === "completed" &&
      (!evaluationsComplete || checkpoint.benchmarkBatch === null || checkpoint.result === null)
    ) {
      context.addIssue({ code: "custom", message: "Completed Checkpoint requires every artifact" });
    }
    if (
      checkpoint.result &&
      (checkpoint.result.chainId !== checkpoint.chainId ||
        checkpoint.result.evaluations.length !== checkpoint.humanTurnIds.length ||
        checkpoint.result.evaluations.some(
          (evaluation, index) => evaluation.turnId !== checkpoint.humanTurnIds[index],
        ) ||
        checkpoint.result.benchmarkBatch.benchmarks.length !== checkpoint.humanTurnIds.length ||
        checkpoint.result.benchmarkBatch.benchmarks.some(
          (benchmark, index) => benchmark.turnId !== checkpoint.humanTurnIds[index],
        ))
    ) {
      context.addIssue({ code: "custom", message: "Completed Checkpoint must match frozen work" });
    }
  });
export type CheckpointWorkState = z.infer<typeof checkpointWorkStateSchema>;

export const sessionStateV4Schema = z.strictObject({
  stateVersion: z.literal(4),
  phase: sessionPhaseSchema,
  interviewLanguage: interviewLanguageSchema,
  policy: coreLoopPolicySchema,
  planRecord: interviewPlanRecordSchema.nullable(),
  execution: attackChainExecutionStateSchema.nullable(),
  checkpoint: checkpointWorkStateSchema.nullable(),
  budgetLimit: z.number().int().min(60).default(60),
  learning: learningStateSchema.default({ gaps: [], rechallenge: null }),
  activeOperation: activeOperationSchema.nullable(),
  failedOperation: failedOperationSchema.nullable(),
});
export type SessionStateV4 = z.infer<typeof sessionStateV4Schema>;

const publicTurnEvaluationSchema = turnEvaluationSchema.omit({ generation: true });
const publicBenchmarkBatchSchema = benchmarkBatchSchema.omit({ generation: true });
export const publicCheckpointSchema = checkpointSchema
  .omit({ evaluations: true, benchmarkBatch: true, generation: true })
  .extend({
    evaluations: z.array(publicTurnEvaluationSchema).min(1).max(4),
    benchmarkBatch: publicBenchmarkBatchSchema,
  });
export type PublicCheckpoint = z.infer<typeof publicCheckpointSchema>;

export function projectCheckpoint(checkpoint: Checkpoint): PublicCheckpoint {
  return publicCheckpointSchema.parse({
    status: checkpoint.status,
    chainId: checkpoint.chainId,
    comparisons: checkpoint.comparisons,
    findings: checkpoint.findings,
    completedAt: checkpoint.completedAt,
    evaluations: checkpoint.evaluations.map((evaluation) => ({
      turnId: evaluation.turnId,
      rubricVersion: evaluation.rubricVersion,
      dimensions: evaluation.dimensions,
      createdAt: evaluation.createdAt,
    })),
    benchmarkBatch: {
      benchmarks: checkpoint.benchmarkBatch.benchmarks,
      createdAt: checkpoint.benchmarkBatch.createdAt,
    },
  });
}

export interface PublicSessionState {
  interviewLanguage: SessionStateV4["interviewLanguage"];
  plan: NonNullable<SessionStateV4["planRecord"]>["plan"] | null;
  execution: {
    chainId: string;
    answerMode: NonNullable<SessionStateV4["execution"]>["answerMode"];
    status: NonNullable<SessionStateV4["execution"]>["status"];
    turns: Array<z.infer<typeof publicQuestionTurnSchema>>;
    completion: NonNullable<SessionStateV4["execution"]>["completion"];
  } | null;
  checkpoint: PublicCheckpoint | null;
  learning: LearningState;
  activeOperation: SessionOperation | null;
  failedOperation: Omit<FailedOperation, "operationToken" | "generation"> | null;
}

export function projectSessionState(state: SessionStateV4): PublicSessionState {
  return {
    interviewLanguage: state.interviewLanguage,
    learning: state.learning,
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
    checkpoint:
      state.checkpoint?.status === "completed" && state.checkpoint.result
        ? projectCheckpoint(state.checkpoint.result)
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
          stage: state.failedOperation.stage,
        }
      : null,
  };
}
