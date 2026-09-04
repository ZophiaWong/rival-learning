import { z } from "zod";

import {
  attackChainCandidateSchema,
  nextQuestionCandidateSchema,
  type AttackChainCandidate,
  type Difficulty,
  type GenerationMetadata,
  type InterviewLanguage,
  type InterviewPlan,
  type NextQuestionCandidate,
  type QuestionContextPacket,
} from "@/server/core-loop/domain";
import { CORE_LOOP_V1_POLICY } from "@/server/core-loop/policy";
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

export interface InterviewAgents {
  planSingleAttackChain(input: PlanSingleAttackChainInput): Promise<PlanOutcome>;
  generateNextQuestion(input: GenerateNextQuestionInput): Promise<NextQuestionOutcome>;
}

const planEnvelopeSchema = z.strictObject({ outcome: attackChainCandidateSchema });
const questionEnvelopeSchema = z.strictObject({ outcome: nextQuestionCandidateSchema });

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

class RoleRunnerInterviewAgents implements InterviewAgents {
  constructor(private readonly roleRunner: RoleRunner) {}

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
      CORE_LOOP_V1_POLICY.plannerContractVersion,
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
      CORE_LOOP_V1_POLICY.questionContractVersion,
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
