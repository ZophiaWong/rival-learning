import { z } from "zod";
import { answerTextSchema, rubricDimensionSchema } from "./domain";

export const calibrationSchema = z.enum(["accurate", "partial", "inaccurate"]);
export const learningGapSchema = z.strictObject({
  id: z.string().min(1),
  findingId: z.string().min(1),
  targetDimension: rubricDimensionSchema,
  priority: z.number().int().min(1).max(3),
  status: z.enum(["open", "improved", "assisted_correction", "unresolved", "deferred"]),
});
export const rechallengePreparationSchema = z.strictObject({
  targetDimension: rubricDimensionSchema,
  microExplanation: z.string().trim().min(1).max(1600),
  question: z.string().trim().min(1).max(1000),
  scenarioChange: z.string().trim().min(1).max(600),
});
export const rechallengeEvaluationSchema = z.strictObject({
  covered: z.boolean(),
  explanation: z.string().trim().min(1).max(1200),
  answerExcerpts: z.array(z.string().min(1).max(400)).max(3),
});
export const rechallengeHintSchema = z.strictObject({
  hint: z.string().trim().min(1).max(600),
});
export const rechallengeSchema = z.strictObject({
  gapId: z.string().min(1),
  preparation: rechallengePreparationSchema,
  hint: z.string().min(1).max(600).nullable(),
  attempts: z.array(z.strictObject({
    answer: answerTextSchema,
    hinted: z.boolean(),
    evaluation: rechallengeEvaluationSchema.nullable(),
  })).max(2),
  outcome: z.enum(["ProximalImprovement", "AssistedCorrection", "unresolved", "deferred"]).nullable(),
});
export const learningStateSchema = z.strictObject({
  gaps: z.array(learningGapSchema).max(3),
  rechallenge: rechallengeSchema.nullable(),
});
export type LearningState = z.infer<typeof learningStateSchema>;
