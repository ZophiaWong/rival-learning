import { z } from "zod";

export const coreLoopPolicySchema = z.strictObject({
  version: z.literal("core-loop-v1"),
  chainPolicyVersion: z.literal("attack-chain-v1"),
  plannerContractVersion: z.literal("interview-plan-v1"),
  questionContractVersion: z.literal("interviewer-question-v1"),
  questionNormalizerVersion: z.literal("question-v1"),
  maxQuestionTurns: z.literal(4),
  maxEvidenceAnchors: z.literal(3),
  maxEvidenceAnchorLines: z.literal(5),
  maxRequestedEvidenceItems: z.literal(3),
  maxSemanticCandidatesPerOperation: z.literal(3),
  maxQuestionContextLines: z.literal(24),
  maxQuestionContextChars: z.literal(4_000),
  maxPlanningInputChars: z.literal(24_000),
  textLimits: z.strictObject({
    knowledgeTarget: z.literal(300),
    difficultyExplanation: z.literal(300),
    requestedEvidencePrompt: z.literal(300),
    question: z.literal(1_000),
    completionExplanation: z.literal(300),
  }),
});

export type CoreLoopPolicy = z.infer<typeof coreLoopPolicySchema>;

const parsedCoreLoopV1Policy = coreLoopPolicySchema.parse({
    version: "core-loop-v1",
    chainPolicyVersion: "attack-chain-v1",
    plannerContractVersion: "interview-plan-v1",
    questionContractVersion: "interviewer-question-v1",
    questionNormalizerVersion: "question-v1",
    maxQuestionTurns: 4,
    maxEvidenceAnchors: 3,
    maxEvidenceAnchorLines: 5,
    maxRequestedEvidenceItems: 3,
    maxSemanticCandidatesPerOperation: 3,
    maxQuestionContextLines: 24,
    maxQuestionContextChars: 4_000,
    maxPlanningInputChars: 24_000,
    textLimits: {
      knowledgeTarget: 300,
      difficultyExplanation: 300,
      requestedEvidencePrompt: 300,
      question: 1_000,
      completionExplanation: 300,
    },
  });

Object.freeze(parsedCoreLoopV1Policy.textLimits);
export const CORE_LOOP_V1_POLICY: Readonly<CoreLoopPolicy> = Object.freeze(
  parsedCoreLoopV1Policy,
);

export function createCoreLoopPolicySnapshot(): CoreLoopPolicy {
  return coreLoopPolicySchema.parse(CORE_LOOP_V1_POLICY);
}
