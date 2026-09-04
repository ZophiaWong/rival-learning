import { z } from "zod";

import {
  generationMetadataSchema,
  generationUsageSchema,
  interviewLanguageSchema,
  interviewPlanSchema,
  publicQuestionTurnSchema,
} from "@/server/core-loop/domain";
import { sessionOperationSchema } from "./state";

const timelineEnvelope = {
  sequence: z.number().int().min(1),
  createdAt: z.iso.datetime(),
};

export const timelineEventSchema = z.discriminatedUnion("type", [
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
    type: z.literal("operation_failed"),
    payload: z.strictObject({
      operation: sessionOperationSchema,
      code: z.string().min(1),
      userMessage: z.string().min(1),
      retryable: z.boolean(),
      usage: generationUsageSchema,
      rejectionCounts: z.record(z.string(), z.number().int().min(1)),
      lastRejectionReason: z.string().min(1).nullable(),
    }),
  }),
]);

export type TimelineEvent = z.infer<typeof timelineEventSchema>;

export function parseTimelineEvent(value: unknown): TimelineEvent {
  return timelineEventSchema.parse(value);
}
