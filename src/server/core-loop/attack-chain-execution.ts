import {
  attackChainExecutionStateSchema,
  publicQuestionTurnSchema,
  type AttackChainExecutionState,
  type GenerationMetadata,
  type InterviewLanguage,
  type NextQuestionCandidate,
  type PublicQuestionTurn,
  type ReadyAttackChain,
} from "./domain";
import type { CoreLoopPolicy } from "./policy";
import { normalizeQuestionV1 } from "./question-normalizer";

export type QuestionSemanticRejectionReason =
  | "question_turn_limit_reached"
  | "execution_not_ready"
  | "first_question_difficulty_mismatch"
  | "difficulty_step_too_large"
  | "unknown_evidence_anchor"
  | "duplicate_evidence_reference"
  | "duplicate_question"
  | "complete_before_answer"
  | "answer_actor_mismatch";

export type AttackChainPendingEvent =
  | {
      type: "question_presented";
      payload: { chainId: string; turn: PublicQuestionTurn; generation: GenerationMetadata };
    }
  | {
      type: "answer_recorded";
      payload:
        | {
            chainId: string;
            turnId: string;
            actor: "candidate";
            text: string;
            generation: GenerationMetadata;
          }
        | { chainId: string; turnId: string; actor: "human"; text: string };
    }
  | {
      type: "control_taken_over";
      payload: {
        chainId: string;
        turnId: string;
        from: "candidate";
        to: "human";
      };
    }
  | {
      type: "attack_chain_completed";
      payload: {
        chainId: string;
        code: "planned_depth_reached" | "knowledge_target_satisfied" | "no_grounded_followup";
        explanation: string;
      };
    };

export type AttackChainTransitionResult =
  | {
      status: "accepted";
      state: AttackChainExecutionState;
      events: AttackChainPendingEvent[];
    }
  | { status: "rejected"; reason: QuestionSemanticRejectionReason };

export function createAttackChainExecutionState(chainId: string): AttackChainExecutionState {
  return attackChainExecutionStateSchema.parse({
    chainId,
    answerMode: "a2a",
    status: "ready_for_next_question",
    turns: [],
    normalizedQuestionKeys: [],
    completion: null,
  });
}

function difficultyIndex(difficulty: ReadyAttackChain["initialDifficulty"]): number {
  return ["baseline", "target", "stretch"].indexOf(difficulty);
}

export function acceptNextQuestionCandidate(input: {
  state: AttackChainExecutionState;
  chain: ReadyAttackChain;
  candidate: NextQuestionCandidate;
  generation: GenerationMetadata;
  policy: CoreLoopPolicy;
  questionTurnId: string;
  now: string;
}): AttackChainTransitionResult {
  const { state, chain, candidate, generation, policy, questionTurnId, now } = input;
  if (state.status !== "ready_for_next_question") {
    return { status: "rejected", reason: "execution_not_ready" };
  }

  if (candidate.status === "complete") {
    if (!state.turns.some((turn) => turn.status === "settled")) {
      return { status: "rejected", reason: "complete_before_answer" };
    }
    const completion = { code: candidate.code, explanation: candidate.explanation, completedAt: now };
    return {
      status: "accepted",
      state: attackChainExecutionStateSchema.parse({
        ...state,
        status: "completed",
        completion,
      }),
      events: [
        {
          type: "attack_chain_completed",
          payload: { chainId: chain.id, code: candidate.code, explanation: candidate.explanation },
        },
      ],
    };
  }

  if (state.turns.length >= policy.maxQuestionTurns) {
    return { status: "rejected", reason: "question_turn_limit_reached" };
  }
  if (state.turns.length === 0 && candidate.question.difficulty !== chain.initialDifficulty) {
    return { status: "rejected", reason: "first_question_difficulty_mismatch" };
  }
  const previousDifficulty = state.turns.at(-1)?.question.difficulty;
  if (
    previousDifficulty &&
    Math.abs(difficultyIndex(candidate.question.difficulty) - difficultyIndex(previousDifficulty)) > 1
  ) {
    return { status: "rejected", reason: "difficulty_step_too_large" };
  }

  const knownAnchorIds = new Set(chain.evidenceAnchors.map((anchor) => anchor.id));
  if (candidate.question.evidenceAnchorIds.some((id) => !knownAnchorIds.has(id))) {
    return { status: "rejected", reason: "unknown_evidence_anchor" };
  }
  if (
    new Set(candidate.question.evidenceAnchorIds).size !==
    candidate.question.evidenceAnchorIds.length
  ) {
    return { status: "rejected", reason: "duplicate_evidence_reference" };
  }

  const normalizationKey = normalizeQuestionV1(candidate.question.text);
  if (state.normalizedQuestionKeys.includes(normalizationKey)) {
    return { status: "rejected", reason: "duplicate_question" };
  }
  const turn = {
    id: questionTurnId,
    ordinal: state.turns.length + 1,
    status: "awaiting_answer" as const,
    question: candidate.question,
    normalizationKey,
    createdAt: now,
    settledAt: null,
    answer: null,
    generation,
  };
  const nextState = attackChainExecutionStateSchema.parse({
    ...state,
    status: "awaiting_answer",
    turns: [...state.turns, turn],
    normalizedQuestionKeys: [...state.normalizedQuestionKeys, normalizationKey],
  });
  return {
    status: "accepted",
    state: nextState,
    events: [
      {
        type: "question_presented",
        payload: {
          chainId: chain.id,
          turn: publicQuestionTurnSchema.parse(turn),
          generation,
        },
      },
    ],
  };
}

export function settleQuestionTurn(input: {
  state: AttackChainExecutionState;
  questionTurnId: string;
  actor: "human";
  answer: string;
  now: string;
} | {
  state: AttackChainExecutionState;
  questionTurnId: string;
  actor: "candidate";
  answer: string;
  generation: GenerationMetadata;
  now: string;
}): AttackChainTransitionResult {
  const active = input.state.turns.at(-1);
  if (
    input.state.status !== "awaiting_answer" ||
    !active ||
    active.id !== input.questionTurnId ||
    active.status !== "awaiting_answer"
  ) {
    return { status: "rejected", reason: "execution_not_ready" };
  }
  if (
    (input.state.answerMode === "a2a" && input.actor !== "candidate") ||
    (input.state.answerMode === "a2h" && input.actor !== "human")
  ) {
    return { status: "rejected", reason: "answer_actor_mismatch" };
  }
  const answer = input.answer.trim();
  if (!answer) return { status: "rejected", reason: "execution_not_ready" };
  const recordedAnswer =
    input.actor === "candidate"
      ? { actor: input.actor, text: answer, generation: input.generation }
      : { actor: input.actor, text: answer };
  return {
    status: "accepted",
    state: attackChainExecutionStateSchema.parse({
      ...input.state,
      status: "ready_for_next_question",
      turns: input.state.turns.map((turn) =>
        turn.id === active.id
          ? {
              ...turn,
              status: "settled",
              settledAt: input.now,
              answer: recordedAnswer,
            }
          : turn,
      ),
    }),
    events: [
      {
        type: "answer_recorded",
        payload:
          input.actor === "candidate"
            ? {
                chainId: input.state.chainId,
                turnId: active.id,
                actor: input.actor,
                text: answer,
                generation: input.generation,
              }
            : {
                chainId: input.state.chainId,
                turnId: active.id,
                actor: input.actor,
                text: answer,
              },
      },
    ],
  };
}

export function takeOverQuestionTurn(
  state: AttackChainExecutionState,
): AttackChainTransitionResult {
  const active = state.turns.at(-1);
  if (
    state.answerMode !== "a2a" ||
    state.status !== "awaiting_answer" ||
    !active ||
    active.status !== "awaiting_answer"
  ) {
    return { status: "rejected", reason: "execution_not_ready" };
  }
  return {
    status: "accepted",
    state: attackChainExecutionStateSchema.parse({ ...state, answerMode: "a2h" }),
    events: [
      {
        type: "control_taken_over",
        payload: {
          chainId: state.chainId,
          turnId: active.id,
          from: "candidate",
          to: "human",
        },
      },
    ],
  };
}

export function completeAtPlannedDepth(input: {
  state: AttackChainExecutionState;
  chain: ReadyAttackChain;
  policy: CoreLoopPolicy;
  interviewLanguage: InterviewLanguage;
  now: string;
}): AttackChainTransitionResult | null {
  if (input.state.status !== "ready_for_next_question") return null;
  const depth = Math.min(input.chain.estimatedDepth, input.policy.maxQuestionTurns);
  if (input.state.turns.length < depth) return null;
  const explanation =
    input.interviewLanguage === "zh-CN"
      ? "已达到这条追问链的计划深度。"
      : "The planned depth for this attack chain has been reached.";
  return {
    status: "accepted",
    state: attackChainExecutionStateSchema.parse({
      ...input.state,
      status: "completed",
      completion: { code: "planned_depth_reached", explanation, completedAt: input.now },
    }),
    events: [
      {
        type: "attack_chain_completed",
        payload: {
          chainId: input.chain.id,
          code: "planned_depth_reached",
          explanation,
        },
      },
    ],
  };
}
