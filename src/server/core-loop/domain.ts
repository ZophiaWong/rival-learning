import { z } from "zod";

import { CORE_LOOP_V2_POLICY } from "./policy";

export const interviewLanguageSchema = z.enum(["zh-CN", "en-US"]);
export type InterviewLanguage = z.infer<typeof interviewLanguageSchema>;

export const difficultySchema = z.enum(["baseline", "target", "stretch"]);
export type Difficulty = z.infer<typeof difficultySchema>;

export const difficultySignalSchema = z.enum([
  "limited_detail",
  "explicit_scope",
  "explicit_decision",
  "quantified_outcome",
  "system_scope",
]);
export type DifficultySignal = z.infer<typeof difficultySignalSchema>;

function boundedUserText(maximum: number) {
  return z
    .string()
    .trim()
    .min(1)
    .refine((value) => Array.from(value).length <= maximum, {
      message: `Must contain at most ${maximum} Unicode characters`,
    });
}

export const difficultyBasisSchema = z.strictObject({
  signals: z.array(difficultySignalSchema).min(1).max(5),
  explanation: boundedUserText(CORE_LOOP_V2_POLICY.textLimits.difficultyExplanation),
});
export type DifficultyBasis = z.infer<typeof difficultyBasisSchema>;

export const evidenceSourceSchema = z.enum(["resume", "project_notes"]);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const rawEvidenceAnchorSchema = z.strictObject({
  source: evidenceSourceSchema,
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
});
export type RawEvidenceAnchor = z.infer<typeof rawEvidenceAnchorSchema>;

export const evidenceAnchorSchema = rawEvidenceAnchorSchema.extend({
  id: z.string().min(1),
  excerpt: z.string().min(1),
});
export type EvidenceAnchor = z.infer<typeof evidenceAnchorSchema>;

export const requestedEvidenceKindSchema = z.enum([
  "responsibility_scope",
  "decision",
  "constraints",
  "outcome",
]);

export const requestedEvidenceSchema = z.strictObject({
  kind: requestedEvidenceKindSchema,
  prompt: boundedUserText(CORE_LOOP_V2_POLICY.textLimits.requestedEvidencePrompt),
});
export type RequestedEvidence = z.infer<typeof requestedEvidenceSchema>;

export const readyAttackChainCandidateSchema = z.strictObject({
  status: z.literal("ready"),
  intent: z.literal("ownership_claim_depth"),
  knowledgeTarget: boundedUserText(CORE_LOOP_V2_POLICY.textLimits.knowledgeTarget),
  evidenceAnchors: z
    .array(rawEvidenceAnchorSchema)
    .min(1)
    .max(CORE_LOOP_V2_POLICY.maxEvidenceAnchors),
  initialDifficulty: difficultySchema,
  difficultyBasis: difficultyBasisSchema,
  estimatedDepth: z.number().int().min(1).max(CORE_LOOP_V2_POLICY.maxQuestionTurns),
});

export const needsInputAttackChainCandidateSchema = z.strictObject({
  status: z.literal("needs_input"),
  intent: z.literal("ownership_claim_depth"),
  reasonCode: z.enum(["no_claim_evidence", "claim_too_vague"]),
  requestedEvidence: z
    .array(requestedEvidenceSchema)
    .min(1)
    .max(CORE_LOOP_V2_POLICY.maxRequestedEvidenceItems),
});

export const attackChainCandidateSchema = z.discriminatedUnion("status", [
  readyAttackChainCandidateSchema,
  needsInputAttackChainCandidateSchema,
]);
export type AttackChainCandidate = z.infer<typeof attackChainCandidateSchema>;

export const readyAttackChainSchema = readyAttackChainCandidateSchema.omit({
  evidenceAnchors: true,
}).extend({
  id: z.string().min(1),
  evidenceAnchors: z
    .array(evidenceAnchorSchema)
    .min(1)
    .max(CORE_LOOP_V2_POLICY.maxEvidenceAnchors),
});

export const needsInputAttackChainSchema = needsInputAttackChainCandidateSchema.extend({
  id: z.string().min(1),
});

export const attackChainSchema = z.discriminatedUnion("status", [
  readyAttackChainSchema,
  needsInputAttackChainSchema,
]);
export type AttackChain = z.infer<typeof attackChainSchema>;
export type ReadyAttackChain = z.infer<typeof readyAttackChainSchema>;

export const interviewPlanSchema = z.strictObject({
  id: z.string().min(1),
  policyVersion: z.literal("attack-chain-v1"),
  createdAt: z.iso.datetime(),
  attackChains: z.tuple([attackChainSchema]),
});
export type InterviewPlan = z.infer<typeof interviewPlanSchema>;

export const generationUsageSchema = z.strictObject({
  requests: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  usageComplete: z.boolean(),
});
export type GenerationUsage = z.infer<typeof generationUsageSchema>;

export const generationMetadataSchema = z.strictObject({
  contractVersion: z.enum([
    "interview-plan-v1",
    "interviewer-question-v1",
    "candidate-answer-v1",
  ]),
  provider: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  usage: generationUsageSchema,
});
export type GenerationMetadata = z.infer<typeof generationMetadataSchema>;

export const candidateAnswerGenerationMetadataSchema = generationMetadataSchema.refine(
  (generation) => generation.contractVersion === "candidate-answer-v1",
  { message: "Candidate answers require candidate-answer-v1 generation metadata" },
);

export const contextLineSchema = z.strictObject({
  source: evidenceSourceSchema,
  lineNumber: z.number().int().min(1),
  text: z.string(),
  evidenceAnchorIds: z.array(z.string().min(1)),
});

export const questionContextPacketSchema = z.strictObject({
  lines: z.array(contextLineSchema).min(1),
  totalLines: z.number().int().min(1).max(CORE_LOOP_V2_POLICY.maxQuestionContextLines),
  totalCharacters: z.number().int().min(0).max(CORE_LOOP_V2_POLICY.maxQuestionContextChars),
});
export type QuestionContextPacket = z.infer<typeof questionContextPacketSchema>;

export const interviewPlanRecordSchema = z.strictObject({
  plan: interviewPlanSchema,
  questionContext: questionContextPacketSchema.nullable(),
  generation: generationMetadataSchema,
});
export type InterviewPlanRecord = z.infer<typeof interviewPlanRecordSchema>;

export const proposedQuestionSchema = z.strictObject({
  text: boundedUserText(CORE_LOOP_V2_POLICY.textLimits.question),
  difficulty: difficultySchema,
  evidenceAnchorIds: z.array(z.string().min(1)).min(1).max(CORE_LOOP_V2_POLICY.maxEvidenceAnchors),
});
export type ProposedQuestion = z.infer<typeof proposedQuestionSchema>;

export const nextQuestionCandidateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ask"), question: proposedQuestionSchema }),
  z.strictObject({
    status: z.literal("complete"),
    code: z.enum(["knowledge_target_satisfied", "no_grounded_followup"]),
    explanation: boundedUserText(CORE_LOOP_V2_POLICY.textLimits.completionExplanation),
  }),
]);
export type NextQuestionCandidate = z.infer<typeof nextQuestionCandidateSchema>;

export const answerTextSchema = boundedUserText(CORE_LOOP_V2_POLICY.textLimits.answer);

export const candidateAnswerSchema = z.strictObject({
  text: answerTextSchema,
});
export type CandidateAnswer = z.infer<typeof candidateAnswerSchema>;

const recordedAnswerSchema = z.discriminatedUnion("actor", [
  z.strictObject({
    actor: z.literal("candidate"),
    text: answerTextSchema,
    generation: candidateAnswerGenerationMetadataSchema,
  }),
  z.strictObject({ actor: z.literal("human"), text: answerTextSchema }),
]);

export const answerModeSchema = z.enum(["a2a", "a2h"]);
export type AnswerMode = z.infer<typeof answerModeSchema>;

export const questionTurnSchema = z.strictObject({
  id: z.string().min(1),
  ordinal: z.number().int().min(1).max(CORE_LOOP_V2_POLICY.maxQuestionTurns),
  status: z.enum(["awaiting_answer", "settled"]),
  question: proposedQuestionSchema,
  normalizationKey: z.string().min(1),
  createdAt: z.iso.datetime(),
  settledAt: z.iso.datetime().nullable(),
  answer: recordedAnswerSchema.nullable(),
  generation: generationMetadataSchema,
});
export type QuestionTurn = z.infer<typeof questionTurnSchema>;

export const attackChainCompletionSchema = z.strictObject({
  code: z.enum([
    "planned_depth_reached",
    "knowledge_target_satisfied",
    "no_grounded_followup",
  ]),
  explanation: boundedUserText(CORE_LOOP_V2_POLICY.textLimits.completionExplanation),
  completedAt: z.iso.datetime(),
});
export type AttackChainCompletion = z.infer<typeof attackChainCompletionSchema>;

export const attackChainExecutionStateSchema = z.strictObject({
  chainId: z.string().min(1),
  answerMode: answerModeSchema,
  status: z.enum(["awaiting_answer", "ready_for_next_question", "completed"]),
  turns: z.array(questionTurnSchema).max(CORE_LOOP_V2_POLICY.maxQuestionTurns),
  normalizedQuestionKeys: z.array(z.string().min(1)).max(CORE_LOOP_V2_POLICY.maxQuestionTurns),
  completion: attackChainCompletionSchema.nullable(),
});
export type AttackChainExecutionState = z.infer<typeof attackChainExecutionStateSchema>;

const publicRecordedAnswerSchema = z.object({
  actor: z.enum(["candidate", "human"]),
  text: answerTextSchema,
});

export const publicQuestionTurnSchema = questionTurnSchema
  .omit({ normalizationKey: true, generation: true })
  .extend({ answer: publicRecordedAnswerSchema.nullable() })
  .strip();
export type PublicQuestionTurn = z.infer<typeof publicQuestionTurnSchema>;
