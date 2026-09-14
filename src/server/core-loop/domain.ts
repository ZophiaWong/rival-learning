import { z } from "zod";

import { CORE_LOOP_V3_POLICY } from "./policy";

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
  explanation: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.difficultyExplanation),
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
  prompt: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.requestedEvidencePrompt),
});
export type RequestedEvidence = z.infer<typeof requestedEvidenceSchema>;

export const readyAttackChainCandidateSchema = z.strictObject({
  status: z.literal("ready"),
  intent: z.literal("ownership_claim_depth"),
  knowledgeTarget: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.knowledgeTarget),
  evidenceAnchors: z
    .array(rawEvidenceAnchorSchema)
    .min(1)
    .max(CORE_LOOP_V3_POLICY.maxEvidenceAnchors),
  initialDifficulty: difficultySchema,
  difficultyBasis: difficultyBasisSchema,
  estimatedDepth: z.number().int().min(1).max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
});

export const needsInputAttackChainCandidateSchema = z.strictObject({
  status: z.literal("needs_input"),
  intent: z.literal("ownership_claim_depth"),
  reasonCode: z.enum(["no_claim_evidence", "claim_too_vague"]),
  requestedEvidence: z
    .array(requestedEvidenceSchema)
    .min(1)
    .max(CORE_LOOP_V3_POLICY.maxRequestedEvidenceItems),
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
    .max(CORE_LOOP_V3_POLICY.maxEvidenceAnchors),
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
    "judge-turn-evaluation-v1",
    "candidate-benchmark-v1",
    "judge-checkpoint-v1",
    "rechallenge-v1",
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
  totalLines: z.number().int().min(1).max(CORE_LOOP_V3_POLICY.maxQuestionContextLines),
  totalCharacters: z.number().int().min(0).max(CORE_LOOP_V3_POLICY.maxQuestionContextChars),
});
export type QuestionContextPacket = z.infer<typeof questionContextPacketSchema>;

export const interviewPlanRecordSchema = z.strictObject({
  plan: interviewPlanSchema,
  questionContext: questionContextPacketSchema.nullable(),
  generation: generationMetadataSchema,
});
export type InterviewPlanRecord = z.infer<typeof interviewPlanRecordSchema>;

export const proposedQuestionSchema = z.strictObject({
  text: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.question),
  difficulty: difficultySchema,
  evidenceAnchorIds: z.array(z.string().min(1)).min(1).max(CORE_LOOP_V3_POLICY.maxEvidenceAnchors),
});
export type ProposedQuestion = z.infer<typeof proposedQuestionSchema>;

export const nextQuestionCandidateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ask"), question: proposedQuestionSchema }),
  z.strictObject({
    status: z.literal("complete"),
    code: z.enum(["knowledge_target_satisfied", "no_grounded_followup"]),
    explanation: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.completionExplanation),
  }),
]);
export type NextQuestionCandidate = z.infer<typeof nextQuestionCandidateSchema>;

export const answerTextSchema = boundedUserText(CORE_LOOP_V3_POLICY.textLimits.answer);

export const candidateAnswerSchema = z.strictObject({
  text: answerTextSchema,
});
export type CandidateAnswer = z.infer<typeof candidateAnswerSchema>;

export const RUBRIC_DIMENSIONS = [
  "answer_relevance",
  "ownership_scope",
  "decision_reasoning",
  "evidence_and_outcome",
  "target_level_depth",
] as const;

export const rubricDimensionSchema = z.enum(RUBRIC_DIMENSIONS);
export type RubricDimension = z.infer<typeof rubricDimensionSchema>;

export const rubricVerdictSchema = z.enum([
  "met",
  "partial",
  "missing",
  "not_applicable",
]);
export type RubricVerdict = z.infer<typeof rubricVerdictSchema>;

function rubricResultSchema<D extends RubricDimension>(dimension: D) {
  return z.strictObject({
    dimension: z.literal(dimension),
    verdict: rubricVerdictSchema,
    rationale: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.checkpointRationale),
    answerExcerpts: z
      .array(boundedUserText(CORE_LOOP_V3_POLICY.textLimits.evidenceExcerpt))
      .max(2),
  });
}

export const turnEvaluationCandidateSchema = z.strictObject({
  dimensions: z.tuple([
    rubricResultSchema("answer_relevance"),
    rubricResultSchema("ownership_scope"),
    rubricResultSchema("decision_reasoning"),
    rubricResultSchema("evidence_and_outcome"),
    rubricResultSchema("target_level_depth"),
  ]),
});
export type TurnEvaluationCandidate = z.infer<typeof turnEvaluationCandidateSchema>;
export type RubricResult = TurnEvaluationCandidate["dimensions"][number];

export const answerRubricVersionSchema = z.literal("answer-rubric-v1");

export const judgeEvaluationGenerationMetadataSchema = generationMetadataSchema.refine(
  (generation) => generation.contractVersion === "judge-turn-evaluation-v1",
  { message: "Turn evaluations require judge-turn-evaluation-v1 generation metadata" },
);

export const turnEvaluationSchema = z.strictObject({
  turnId: z.string().min(1),
  rubricVersion: answerRubricVersionSchema,
  dimensions: turnEvaluationCandidateSchema.shape.dimensions,
  generation: judgeEvaluationGenerationMetadataSchema,
  createdAt: z.iso.datetime(),
});
export type TurnEvaluation = z.infer<typeof turnEvaluationSchema>;

export const benchmarkCandidateSchema = z.strictObject({
  turnId: z.string().min(1),
  text: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.benchmark),
  evidenceAnchorIds: z
    .array(z.string().min(1))
    .min(1)
    .max(CORE_LOOP_V3_POLICY.maxEvidenceAnchors),
});
export type BenchmarkCandidate = z.infer<typeof benchmarkCandidateSchema>;
export type Benchmark = BenchmarkCandidate;

export const benchmarkBatchCandidateSchema = z.strictObject({
  benchmarks: z
    .array(benchmarkCandidateSchema)
    .min(1)
    .max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
});
export type BenchmarkBatchCandidate = z.infer<typeof benchmarkBatchCandidateSchema>;

export const candidateBenchmarkGenerationMetadataSchema = generationMetadataSchema.refine(
  (generation) => generation.contractVersion === "candidate-benchmark-v1",
  { message: "Benchmark batches require candidate-benchmark-v1 generation metadata" },
);

export const benchmarkBatchSchema = benchmarkBatchCandidateSchema.extend({
  generation: candidateBenchmarkGenerationMetadataSchema,
  createdAt: z.iso.datetime(),
});
export type BenchmarkBatch = z.infer<typeof benchmarkBatchSchema>;

export const turnDifferenceCandidateSchema = z.strictObject({
  dimension: rubricDimensionSchema,
  explanation: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.checkpointRationale),
  answerExcerpt: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.evidenceExcerpt).nullable(),
  benchmarkExcerpt: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.evidenceExcerpt),
});
export type TurnDifference = z.infer<typeof turnDifferenceCandidateSchema>;

export const turnComparisonCandidateSchema = z.strictObject({
  turnId: z.string().min(1),
  differences: z.array(turnDifferenceCandidateSchema).max(RUBRIC_DIMENSIONS.length),
});
export type TurnComparison = z.infer<typeof turnComparisonCandidateSchema>;

export const gapFindingCandidateSchema = z.strictObject({
  targetDimension: rubricDimensionSchema,
  summary: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.findingSummary),
  basis: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.checkpointRationale),
  sourceTurnIds: z
    .array(z.string().min(1))
    .min(1)
    .max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
});

export const checkpointReportCandidateSchema = z.strictObject({
  comparisons: z
    .array(turnComparisonCandidateSchema)
    .max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
  findings: z.array(gapFindingCandidateSchema).max(3),
});
export type CheckpointReportCandidate = z.infer<typeof checkpointReportCandidateSchema>;

export const judgeCheckpointGenerationMetadataSchema = generationMetadataSchema.refine(
  (generation) => generation.contractVersion === "judge-checkpoint-v1",
  { message: "Checkpoints require judge-checkpoint-v1 generation metadata" },
);

export const gapFindingSchema = gapFindingCandidateSchema.extend({
  id: z.string().min(1),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  calibration: z.enum(["unreviewed", "accurate", "partial", "inaccurate"]),
});
export type GapFinding = z.infer<typeof gapFindingSchema>;

export const checkpointSchema = z.strictObject({
  status: z.literal("completed"),
  chainId: z.string().min(1),
  evaluations: z
    .array(turnEvaluationSchema)
    .min(1)
    .max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
  benchmarkBatch: benchmarkBatchSchema,
  comparisons: z
    .array(turnComparisonCandidateSchema)
    .min(1)
    .max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
  findings: z.array(gapFindingSchema).max(3),
  generation: judgeCheckpointGenerationMetadataSchema,
  completedAt: z.iso.datetime(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

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
  ordinal: z.number().int().min(1).max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
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
  explanation: boundedUserText(CORE_LOOP_V3_POLICY.textLimits.completionExplanation),
  completedAt: z.iso.datetime(),
});
export type AttackChainCompletion = z.infer<typeof attackChainCompletionSchema>;

export const attackChainExecutionStateSchema = z.strictObject({
  chainId: z.string().min(1),
  answerMode: answerModeSchema,
  status: z.enum(["awaiting_answer", "ready_for_next_question", "completed"]),
  turns: z.array(questionTurnSchema).max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
  normalizedQuestionKeys: z.array(z.string().min(1)).max(CORE_LOOP_V3_POLICY.maxQuestionTurns),
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
