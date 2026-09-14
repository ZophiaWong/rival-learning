import { calibrationSchema, learningStateSchema } from "@/server/core-loop/learning";
import { z } from "zod";

import {
  answerTextSchema,
  candidateBenchmarkGenerationMetadataSchema,
  candidateAnswerGenerationMetadataSchema,
  generationMetadataSchema,
  generationUsageSchema,
  interviewLanguageSchema,
  interviewPlanSchema,
  judgeCheckpointGenerationMetadataSchema,
  judgeEvaluationGenerationMetadataSchema,
  publicQuestionTurnSchema,
} from "@/server/core-loop/domain";
import {
  checkpointStageSchema,
  publicCheckpointSchema,
  sessionOperationSchema,
} from "./state";

const timelineEnvelope = {
  sequence: z.number().int().min(1),
  createdAt: z.iso.datetime(),
};

export const timelineEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...timelineEnvelope, type: z.literal("finding_calibrated"), payload: z.strictObject({ findingId: z.string().min(1), calibration: calibrationSchema }) }),
  z.strictObject({ ...timelineEnvelope, type: z.literal("learning_updated"), payload: z.strictObject({ action: z.string().min(1), learning: learningStateSchema, generation: generationMetadataSchema.optional() }) }),
  z.strictObject({ ...timelineEnvelope, type: z.literal("reflection_added"), payload: z.strictObject({ turnId: z.string().min(1), text: answerTextSchema }) }),
  z.strictObject({ ...timelineEnvelope, type: z.literal("budget_extended"), payload: z.strictObject({ limit: z.number().int().min(80), added: z.literal(20) }) }),
  z.strictObject({ ...timelineEnvelope, type: z.literal("operation_resumed"), payload: z.strictObject({ operation: sessionOperationSchema }) }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("session_created"),
    payload: z.strictObject({ interviewLanguage: interviewLanguageSchema }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("operation_started"),
    payload: z.strictObject({ operation: sessionOperationSchema }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("interview_plan_generated"),
    payload: z.strictObject({
      status: z.enum(["ready", "needs_input"]),
      plan: interviewPlanSchema,
      generation: generationMetadataSchema,
    }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("session_started"),
    payload: z.strictObject({ chainId: z.string().min(1) }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("question_presented"),
    payload: z.strictObject({
      chainId: z.string().min(1),
      turn: publicQuestionTurnSchema,
      generation: generationMetadataSchema,
    }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("answer_recorded"),
    payload: z.discriminatedUnion("actor", [
      z.strictObject({
        chainId: z.string().min(1),
        turnId: z.string().min(1),
        actor: z.literal("candidate"),
        text: answerTextSchema,
        generation: candidateAnswerGenerationMetadataSchema,
      }),
      z.strictObject({
        chainId: z.string().min(1),
        turnId: z.string().min(1),
        actor: z.literal("human"),
        text: answerTextSchema,
      }),
    ]),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("control_taken_over"),
    payload: z.strictObject({
      chainId: z.string().min(1),
      turnId: z.string().min(1),
      from: z.literal("candidate"),
      to: z.literal("human"),
    }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("attack_chain_completed"),
    payload: z.strictObject({
      chainId: z.string().min(1),
      code: z.enum([
        "planned_depth_reached",
        "knowledge_target_satisfied",
        "no_grounded_followup",
      ]),
      explanation: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("turn_evaluation_recorded"),
    payload: z.strictObject({
      chainId: z.string().min(1),
      turnId: z.string().min(1),
      rubricVersion: z.literal("answer-rubric-v1"),
      generation: judgeEvaluationGenerationMetadataSchema,
    }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("benchmarks_generated"),
    payload: z.strictObject({
      chainId: z.string().min(1),
      turnIds: z.array(z.string().min(1)).min(1).max(4),
      count: z.number().int().min(1).max(4),
      generation: candidateBenchmarkGenerationMetadataSchema,
    }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("checkpoint_generated"),
    payload: z.strictObject({
      checkpoint: publicCheckpointSchema,
      generation: judgeCheckpointGenerationMetadataSchema,
    }),
  }),
  z.strictObject({
    ...timelineEnvelope,
    type: z.literal("operation_failed"),
    payload: z.strictObject({
      operation: sessionOperationSchema,
      code: z.string().min(1),
      userMessage: z.string().min(1),
      retryable: z.boolean(),
      usage: generationUsageSchema,
      rejectionCounts: z.record(z.string(), z.number().int().min(1)),
      lastRejectionReason: z.string().min(1).nullable(),
      stage: checkpointStageSchema.nullable().default(null),
    }),
  }),
]);

export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export function parseTimelineEvent(value: unknown): TimelineEvent {
  return timelineEventSchema.parse(value);
}
