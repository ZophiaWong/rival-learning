import { rechallengePreparationSchema, rechallengeEvaluationSchema, rechallengeHintSchema } from "@/server/core-loop/learning";
import { z } from "zod";

import {
  attackChainCandidateSchema,
  benchmarkBatchCandidateSchema,
  candidateAnswerSchema,
  checkpointReportCandidateSchema,
  nextQuestionCandidateSchema,
  RUBRIC_DIMENSIONS,
  turnEvaluationCandidateSchema,
  type AttackChainCandidate,
  type BenchmarkBatchCandidate,
  type BenchmarkCandidate,
  type CandidateAnswer,
  type CheckpointReportCandidate,
  type Difficulty,
  type GenerationMetadata,
  type InterviewLanguage,
  type InterviewPlan,
  type NextQuestionCandidate,
  type QuestionContextPacket,
  type TurnEvaluationCandidate,
} from "@/server/core-loop/domain";
import { CORE_LOOP_V3_POLICY } from "@/server/core-loop/policy";
import type { ProviderViewContent } from "@/server/preparation-profiles";
import type {
  RoleRunErrorCode,
  RoleRunner,
  RoleRunUsage,
} from "./role-runner";

export interface PublicTranscriptTurn {
  question: string;
  answer: { actor: "candidate" | "human"; text: string } | null;
}

export interface PlanSingleAttackChainInput {
  operationToken: string;
  interviewLanguage: InterviewLanguage;
  providerView: ProviderViewContent;
  semanticRejections: string[];
}

export interface GenerateNextQuestionInput {
  operationToken: string;
  interviewLanguage: InterviewLanguage;
  plan: InterviewPlan;
  questionContext: QuestionContextPacket;
  jobDescription: string;
  targetRole: string;
  targetLevel: string;
  publicTranscript: PublicTranscriptTurn[];
  currentDifficulty: Difficulty | null;
  remainingDepth: number;
  semanticRejections: string[];
}

export interface GenerateCandidateAnswerInput {
  operationToken: string;
  interviewLanguage: InterviewLanguage;
  questionContext: QuestionContextPacket;
  jobDescription: string;
  targetRole: string;
  targetLevel: string;
  currentQuestion: string;
  publicTranscript: PublicTranscriptTurn[];
}

export interface EvaluateHumanAnswerInput {
  operationToken: string;
  interviewLanguage: InterviewLanguage;
  rubricVersion: "answer-rubric-v1";
  questionContext: QuestionContextPacket;
  jobDescription: string;
  targetRole: string;
  targetLevel: string;
  knowledgeTarget: string;
  currentTurn: { id: string; question: string; answer: string };
  priorPublicTranscript: PublicTranscriptTurn[];
  semanticRejections: string[];
}

export interface GenerateBenchmarksInput {
  operationToken: string;
  interviewLanguage: InterviewLanguage;
  questionContext: QuestionContextPacket;
  jobDescription: string;
  targetRole: string;
  targetLevel: string;
  knowledgeTarget: string;
  humanQuestions: Array<{
    turnId: string;
    question: string;
    evidenceAnchorIds: string[];
  }>;
  semanticRejections: string[];
}

export interface GenerateCheckpointReportInput {
  operationToken: string;
  interviewLanguage: InterviewLanguage;
  questionContext: QuestionContextPacket;
  jobDescription: string;
  targetRole: string;
  targetLevel: string;
  knowledgeTarget: string;
  humanTurns: Array<{ turnId: string; question: string; answer: string }>;
  evaluations: Array<{
    turnId: string;
    dimensions: TurnEvaluationCandidate["dimensions"];
  }>;
  benchmarks: BenchmarkCandidate[];
  publicTranscript: PublicTranscriptTurn[];
  semanticRejections: string[];
}

export type AgentCandidateResult<T> =
  | { status: "success"; value: T; generation: GenerationMetadata }
  | {
      status: "failure";
      code: RoleRunErrorCode | "agent_unexpected_error";
      message: string;
      retryable: boolean;
      generation: GenerationMetadata;
    };

export type PlanOutcome = AgentCandidateResult<AttackChainCandidate>;
export type NextQuestionOutcome = AgentCandidateResult<NextQuestionCandidate>;
export type CandidateAnswerOutcome = AgentCandidateResult<CandidateAnswer>;
export type TurnEvaluationOutcome = AgentCandidateResult<TurnEvaluationCandidate>;
export type BenchmarkBatchOutcome = AgentCandidateResult<BenchmarkBatchCandidate>;
export type CheckpointReportOutcome = AgentCandidateResult<CheckpointReportCandidate>;

export interface LearningInput {
  interviewLanguage: InterviewLanguage;
  targetRole: string;
  targetLevel: string;
  targetDimension: import("@/server/core-loop/domain").RubricDimension;
  findingSummary: string;
  originalQuestions: string[];
  evidenceContext: QuestionContextPacket;
}
export interface EvaluateRechallengeInput {
  interviewLanguage: InterviewLanguage;
  targetRole: string;
  targetLevel: string;
  targetDimension: import("@/server/core-loop/domain").RubricDimension;
  question: string;
  answer: string;
}

export interface InterviewAgents {
  prepareRechallenge(input: LearningInput): Promise<AgentCandidateResult<z.infer<typeof rechallengePreparationSchema>>>;
  evaluateRechallenge(input: EvaluateRechallengeInput): Promise<AgentCandidateResult<z.infer<typeof rechallengeEvaluationSchema>>>;
  generateHint(input: Omit<EvaluateRechallengeInput, "answer">): Promise<AgentCandidateResult<z.infer<typeof rechallengeHintSchema>>>;
  planSingleAttackChain(input: PlanSingleAttackChainInput): Promise<PlanOutcome>;
  generateNextQuestion(input: GenerateNextQuestionInput): Promise<NextQuestionOutcome>;
  generateCandidateAnswer(input: GenerateCandidateAnswerInput): Promise<CandidateAnswerOutcome>;
  evaluateHumanAnswer(input: EvaluateHumanAnswerInput): Promise<TurnEvaluationOutcome>;
  generateBenchmarks(input: GenerateBenchmarksInput): Promise<BenchmarkBatchOutcome>;
  generateCheckpointReport(
    input: GenerateCheckpointReportInput,
  ): Promise<CheckpointReportOutcome>;
}

const planEnvelopeSchema = z.strictObject({ outcome: attackChainCandidateSchema });
const questionEnvelopeSchema = z.strictObject({ outcome: nextQuestionCandidateSchema });
const candidateAnswerEnvelopeSchema = z.strictObject({ outcome: candidateAnswerSchema });
const turnEvaluationEnvelopeSchema = z.strictObject({ outcome: turnEvaluationCandidateSchema });
const benchmarkBatchEnvelopeSchema = z.strictObject({ outcome: benchmarkBatchCandidateSchema });
const checkpointReportEnvelopeSchema = z.strictObject({
  outcome: checkpointReportCandidateSchema,
});

function isRetryable(code: RoleRunErrorCode): boolean {
  return [
    "provider_rate_limited",
    "provider_timeout",
    "provider_unavailable",
    "schema_invalid",
  ].includes(code);
}

function generationMetadata(
  contractVersion: GenerationMetadata["contractVersion"],
  usage: RoleRunUsage,
  attempts: Array<{ providerId: string; model: string }>,
): GenerationMetadata {
  const lastAttempt = attempts.at(-1);
  return {
    contractVersion,
    provider: lastAttempt?.providerId ?? null,
    model: lastAttempt?.model ?? null,
    usage,
  };
}

function planningInstructions(language: InterviewLanguage): string {
  const outputLanguage = language === "zh-CN" ? "Simplified Chinese" : "English";
  return `You are the Interviewer planning one evidence-grounded attack chain.
Return exactly one outcome. The intent is ownership_claim_depth.
Select the strongest concrete claim from Resume or Project Notes. Evidence anchors must use only resume or project_notes and exact 1-based inclusive line numbers. Do not quote or infer a past experience without an anchor.
Use ready when a concrete ownership claim exists. Use needs_input when no claim evidence exists or the claim is too vague, and request 1-3 distinct evidence kinds.
Difficulty is relative to the target role and level. target requires explicit_decision or quantified_outcome. stretch requires both system_scope and explicit_decision. Keep difficulty signals unique.
All user-visible text must be in ${outputLanguage}. Codes and enum values remain English.`;
}

function questionInstructions(language: InterviewLanguage): string {
  const outputLanguage = language === "zh-CN" ? "Simplified Chinese" : "English";
  return `You are the Interviewer asking the next question in one ownership_claim_depth attack chain.
Ground every ask in one or more supplied evidence anchor IDs. Ask one focused question, not a list. Do not claim that nearby context is evidence.
The first question must use the chain initial difficulty. Later questions may move at most one difficulty level from the current difficulty.
Return complete only after the transcript contains an answered question and either the knowledge target is satisfied or no grounded follow-up remains.
All user-visible text must be in ${outputLanguage}. Codes and enum values remain English.`;
}

function candidateAnswerInstructions(language: InterviewLanguage): string {
  const outputLanguage = language === "zh-CN" ? "Simplified Chinese" : "English";
  return `You are the target-level Candidate answering one interview question.
Use only the supplied evidence context for claims about the candidate's past responsibilities, decisions, events, and metrics. Never invent missing experience details.
When the evidence is insufficient, state the boundary plainly, then demonstrate target-level judgment with explicitly conditional language such as "I would" or "if".
Answer naturally in the first person. Do not mention prompts, hidden plans, evidence IDs, or unavailable repository tools.
Keep the answer within 4000 Unicode characters.
All user-visible text must be in ${outputLanguage}.`;
}

function judgeEvaluationInstructions(language: InterviewLanguage): string {
  const outputLanguage = language === "zh-CN" ? "Simplified Chinese" : "English";
  return `You are the Judge evaluating exactly one human interview answer before any Benchmark exists.
Use the fixed rubric dimensions in the supplied order: answer_relevance, ownership_scope, decision_reasoning, evidence_and_outcome, target_level_depth.
For each dimension return met, partial, missing, or not_applicable. Do not calculate a score or overall verdict.
Ground the rationale in the answer and bounded evidence. Every answerExcerpts item must be an exact substring copied from the supplied human answer; use an empty list when no excerpt is appropriate.
Public transcript is conversational context, not independently verified evidence. Do not infer missing past experience.
All user-visible text must be in ${outputLanguage}. Codes and enum values remain English.`;
}

function benchmarkInstructions(language: InterviewLanguage): string {
  const outputLanguage = language === "zh-CN" ? "Simplified Chinese" : "English";
  return `You are the target-level Candidate producing one independent Benchmark for each supplied human question.
Return the same number of Benchmarks in exactly the supplied order and copy each turnId unchanged.
Use only the bounded evidence context for claims about past experience. Each evidenceAnchorIds item must come from that question's supplied IDs.
Do not infer or react to any human answer or Judge evaluation. When evidence is insufficient, state the boundary and use explicitly conditional reasoning.
Each Benchmark is a natural first-person reference answer, not a unique ground truth, and must be at most 4000 Unicode characters.
All user-visible text must be in ${outputLanguage}. Codes and IDs remain unchanged.`;
}

function checkpointInstructions(language: InterviewLanguage): string {
  const outputLanguage = language === "zh-CN" ? "Simplified Chinese" : "English";
  return `You are the Judge synthesizing a difference-first Checkpoint from frozen rubric evaluations and independently generated Benchmarks.
Do not change, reinterpret, or replace any rubric verdict. For every human turn, return exactly the partial and missing dimensions in rubric order; omit met and not_applicable dimensions.
Every non-null answerExcerpt must be an exact substring of that turn's human answer. Every benchmarkExcerpt must be an exact substring of that turn's Benchmark.
Return zero to three ordered GapFinding candidates. Each targetDimension may appear at most once, and every sourceTurnId must have a partial or missing verdict for that dimension.
Candidate answers in public transcript are context only and must never be attributed as a user gap. Do not calculate a score or reveal hidden reasoning.
All user-visible text must be in ${outputLanguage}. Codes and IDs remain unchanged.`;
}

class RoleRunnerInterviewAgents implements InterviewAgents {
  constructor(private readonly roleRunner: RoleRunner) {}

  private async learningOperation<T>(role: "interviewer" | "judge", operation: string, instructions: string, input: unknown, schema: z.ZodType<T>): Promise<AgentCandidateResult<T>> {
    const result = await this.roleRunner.runStructured({ role, operation, instructions,
      input: JSON.stringify(input), outputSchema: z.strictObject({ outcome: schema }) });
    const generation = generationMetadata("rechallenge-v1", result.usage, result.attempts);
    if (result.status === "failure") return { status: "failure", code: result.error.code,
      message: result.error.message, retryable: isRetryable(result.error.code), generation };
    return { status: "success", value: result.value.outcome, generation };
  }

  prepareRechallenge(input: LearningInput) {
    return this.learningOperation("interviewer", "prepare_rechallenge",
      `Create a short micro-explanation for the accepted learning gap, then one hypothetical transfer question.
Use a materially different scenario from ALL original questions, keeping exactly the supplied targetDimension. Explain the concrete scenario change.
The explanation teaches the general principle without answering the new question. Do not invent past experience.
Do not include a solution or hint for the new question. User-visible text: ${input.interviewLanguage}.`,
      { interviewLanguage: input.interviewLanguage, targetRole: input.targetRole, targetLevel: input.targetLevel,
        targetDimension: input.targetDimension, findingSummary: input.findingSummary,
        originalQuestions: input.originalQuestions, evidenceContext: input.evidenceContext }, rechallengePreparationSchema);
  }

  evaluateRechallenge(input: EvaluateRechallengeInput) {
    return this.learningOperation("judge", "evaluate_rechallenge",
      `Evaluate only whether this answer actively covers the supplied targetDimension in the new scenario.
Do not infer unstated understanding. covered=true requires at least one exact answer excerpt demonstrating coverage.
All answerExcerpts must be exact substrings of the supplied answer. Explain briefly; no scores or mastery claims.
User-visible text: ${input.interviewLanguage}.`,
      { interviewLanguage: input.interviewLanguage, targetRole: input.targetRole, targetLevel: input.targetLevel,
        targetDimension: input.targetDimension, question: input.question, answer: input.answer }, rechallengeEvaluationSchema);
  }

  generateHint(input: Omit<EvaluateRechallengeInput, "answer">) {
    return this.learningOperation("interviewer", "generate_rechallenge_hint",
      `Give exactly one L1 hint: a brief directional cue toward the targetDimension, without a full answer or worked solution.
User-visible text: ${input.interviewLanguage}.`,
      { interviewLanguage: input.interviewLanguage, targetRole: input.targetRole, targetLevel: input.targetLevel,
        targetDimension: input.targetDimension, question: input.question }, rechallengeHintSchema);
  }

  async planSingleAttackChain(input: PlanSingleAttackChainInput): Promise<PlanOutcome> {
    const result = await this.roleRunner.runStructured({
      role: "interviewer",
      operation: "plan_single_attack_chain",
      instructions: planningInstructions(input.interviewLanguage),
      input: JSON.stringify({
        interviewLanguage: input.interviewLanguage,
        providerView: input.providerView,
        semanticRejections: input.semanticRejections,
      }),
      outputSchema: planEnvelopeSchema,
    });
    const generation = generationMetadata(
      CORE_LOOP_V3_POLICY.plannerContractVersion,
      result.usage,
      result.attempts,
    );
    if (result.status === "failure") {
      return {
        status: "failure",
        code: result.error.code,
        message: result.error.message,
        retryable: isRetryable(result.error.code),
        generation,
      };
    }
    return { status: "success", value: result.value.outcome, generation };
  }

  async generateNextQuestion(input: GenerateNextQuestionInput): Promise<NextQuestionOutcome> {
    const result = await this.roleRunner.runStructured({
      role: "interviewer",
      operation: "generate_next_question",
      instructions: questionInstructions(input.interviewLanguage),
      input: JSON.stringify({
        interviewLanguage: input.interviewLanguage,
        hiringBar: {
          jobDescription: input.jobDescription,
          targetRole: input.targetRole,
          targetLevel: input.targetLevel,
        },
        plan: input.plan,
        evidenceContext: input.questionContext,
        publicTranscript: input.publicTranscript,
        currentDifficulty: input.currentDifficulty,
        remainingDepth: input.remainingDepth,
        semanticRejections: input.semanticRejections,
      }),
      outputSchema: questionEnvelopeSchema,
    });
    const generation = generationMetadata(
      CORE_LOOP_V3_POLICY.questionContractVersion,
      result.usage,
      result.attempts,
    );
    if (result.status === "failure") {
      return {
        status: "failure",
        code: result.error.code,
        message: result.error.message,
        retryable: isRetryable(result.error.code),
        generation,
      };
    }
    return { status: "success", value: result.value.outcome, generation };
  }

  async generateCandidateAnswer(
    input: GenerateCandidateAnswerInput,
  ): Promise<CandidateAnswerOutcome> {
    const result = await this.roleRunner.runStructured({
      role: "candidate",
      operation: "generate_candidate_answer",
      instructions: candidateAnswerInstructions(input.interviewLanguage),
      input: JSON.stringify({
        interviewLanguage: input.interviewLanguage,
        hiringBar: {
          jobDescription: input.jobDescription,
          targetRole: input.targetRole,
          targetLevel: input.targetLevel,
        },
        evidenceContext: input.questionContext,
        publicTranscript: input.publicTranscript,
        currentQuestion: input.currentQuestion,
      }),
      outputSchema: candidateAnswerEnvelopeSchema,
    });
    const generation = generationMetadata(
      CORE_LOOP_V3_POLICY.candidateAnswerContractVersion,
      result.usage,
      result.attempts,
    );
    if (result.status === "failure") {
      return {
        status: "failure",
        code: result.error.code,
        message: result.error.message,
        retryable: isRetryable(result.error.code),
        generation,
      };
    }
    return { status: "success", value: result.value.outcome, generation };
  }

  async evaluateHumanAnswer(input: EvaluateHumanAnswerInput): Promise<TurnEvaluationOutcome> {
    const result = await this.roleRunner.runStructured({
      role: "judge",
      operation: "evaluate_human_answer",
      instructions: judgeEvaluationInstructions(input.interviewLanguage),
      input: JSON.stringify({
        interviewLanguage: input.interviewLanguage,
        rubric: {
          version: input.rubricVersion,
          dimensions: RUBRIC_DIMENSIONS,
        },
        hiringBar: {
          jobDescription: input.jobDescription,
          targetRole: input.targetRole,
          targetLevel: input.targetLevel,
        },
        knowledgeTarget: input.knowledgeTarget,
        evidenceContext: input.questionContext,
        currentTurn: input.currentTurn,
        priorPublicTranscript: input.priorPublicTranscript,
        semanticRejections: input.semanticRejections,
      }),
      outputSchema: turnEvaluationEnvelopeSchema,
    });
    const generation = generationMetadata(
      CORE_LOOP_V3_POLICY.judgeEvaluationContractVersion,
      result.usage,
      result.attempts,
    );
    if (result.status === "failure") {
      return {
        status: "failure",
        code: result.error.code,
        message: result.error.message,
        retryable: isRetryable(result.error.code),
        generation,
      };
    }
    return { status: "success", value: result.value.outcome, generation };
  }

  async generateBenchmarks(input: GenerateBenchmarksInput): Promise<BenchmarkBatchOutcome> {
    const result = await this.roleRunner.runStructured({
      role: "candidate",
      operation: "generate_benchmark_batch",
      instructions: benchmarkInstructions(input.interviewLanguage),
      input: JSON.stringify({
        interviewLanguage: input.interviewLanguage,
        hiringBar: {
          jobDescription: input.jobDescription,
          targetRole: input.targetRole,
          targetLevel: input.targetLevel,
        },
        knowledgeTarget: input.knowledgeTarget,
        evidenceContext: input.questionContext,
        humanQuestions: input.humanQuestions,
        semanticRejections: input.semanticRejections,
      }),
      outputSchema: benchmarkBatchEnvelopeSchema,
    });
    const generation = generationMetadata(
      CORE_LOOP_V3_POLICY.benchmarkContractVersion,
      result.usage,
      result.attempts,
    );
    if (result.status === "failure") {
      return {
        status: "failure",
        code: result.error.code,
        message: result.error.message,
        retryable: isRetryable(result.error.code),
        generation,
      };
    }
    return { status: "success", value: result.value.outcome, generation };
  }

  async generateCheckpointReport(
    input: GenerateCheckpointReportInput,
  ): Promise<CheckpointReportOutcome> {
    const result = await this.roleRunner.runStructured({
      role: "judge",
      operation: "generate_checkpoint_report",
      instructions: checkpointInstructions(input.interviewLanguage),
      input: JSON.stringify({
        interviewLanguage: input.interviewLanguage,
        hiringBar: {
          jobDescription: input.jobDescription,
          targetRole: input.targetRole,
          targetLevel: input.targetLevel,
        },
        knowledgeTarget: input.knowledgeTarget,
        evidenceContext: input.questionContext,
        humanTurns: input.humanTurns,
        evaluations: input.evaluations,
        benchmarks: input.benchmarks,
        publicTranscript: input.publicTranscript,
        semanticRejections: input.semanticRejections,
      }),
      outputSchema: checkpointReportEnvelopeSchema,
    });
    const generation = generationMetadata(
      CORE_LOOP_V3_POLICY.checkpointContractVersion,
      result.usage,
      result.attempts,
    );
    if (result.status === "failure") {
      return {
        status: "failure",
        code: result.error.code,
        message: result.error.message,
        retryable: isRetryable(result.error.code),
        generation,
      };
    }
    return { status: "success", value: result.value.outcome, generation };
  }
}

export function createInterviewAgents(roleRunner: RoleRunner): InterviewAgents {
  return new RoleRunnerInterviewAgents(roleRunner);
}
