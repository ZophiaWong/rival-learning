import { describe, expect, it } from "vitest";

import {
  acceptNextQuestionCandidate,
  completeAtPlannedDepth,
  createAttackChainExecutionState,
  settleQuestionTurn,
  takeOverQuestionTurn,
} from "@/server/core-loop/attack-chain-execution";
import {
  answerTextSchema,
  attackChainCandidateSchema,
  interviewLanguageSchema,
  publicQuestionTurnSchema,
  type GenerationMetadata,
  type ReadyAttackChain,
} from "@/server/core-loop/domain";
import {
  materializeInterviewPlanCandidate,
  measurePlanningInput,
} from "@/server/core-loop/grounding";
import {
  CORE_LOOP_V2_POLICY,
  coreLoopPolicySchema,
  createCoreLoopPolicySnapshot,
} from "@/server/core-loop/policy";
import { normalizeQuestionV1 } from "@/server/core-loop/question-normalizer";
import type { ProviderViewContent } from "@/server/preparation-profiles";

const generation: GenerationMetadata = {
  contractVersion: "interviewer-question-v1",
  provider: "openrouter",
  model: "synthetic/model",
  usage: { requests: 1, inputTokens: 10, outputTokens: 5, usageComplete: true },
};

const candidateGeneration: GenerationMetadata = {
  ...generation,
  contractVersion: "candidate-answer-v1",
  model: "synthetic/candidate",
};

const providerView: ProviderViewContent = {
  resume: "Summary\n\nOwned the queue migration\nReduced failures by 35%\n\nUnrelated claim",
  projectNotes: "# Payments\nContext line\nMade the retry decision\n## Detail\nMore detail\n# Search\nOther project",
  jobDescription: "Own distributed backend systems",
  targetRole: "Backend Engineer",
  targetLevel: "Senior",
};

function ids() {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

function materialize(overrides: Record<string, unknown> = {}) {
  return materializeInterviewPlanCandidate({
    candidate: attackChainCandidateSchema.parse({
      status: "ready",
      intent: "ownership_claim_depth",
      knowledgeTarget: "Verify ownership and decision depth",
      evidenceAnchors: [{ source: "resume", startLine: 3, endLine: 4 }],
      initialDifficulty: "target",
      difficultyBasis: {
        signals: ["quantified_outcome"],
        explanation: "The claim includes a quantified outcome.",
      },
      estimatedDepth: 3,
      ...overrides,
    }),
    providerView,
    generation: { ...generation, contractVersion: "interview-plan-v1" },
    policy: createCoreLoopPolicySnapshot(),
    createId: ids(),
    createdAt: "2026-09-04T08:00:00.000Z",
  });
}

describe("core-loop v2 policy and schemas", () => {
  it("keeps every core-loop limit and contract in one parsed immutable snapshot", () => {
    expect(coreLoopPolicySchema.parse(CORE_LOOP_V2_POLICY)).toMatchObject({
      version: "core-loop-v2",
      candidateAnswerContractVersion: "candidate-answer-v1",
      maxQuestionTurns: 4,
      maxEvidenceAnchors: 3,
      maxSemanticCandidatesPerOperation: 3,
      maxQuestionContextLines: 24,
      maxQuestionContextChars: 4_000,
      maxPlanningInputChars: 24_000,
      textLimits: { answer: 4_000 },
      questionNormalizerVersion: "question-v1",
    });
    expect(Object.isFrozen(CORE_LOOP_V2_POLICY)).toBe(true);
    expect(Object.isFrozen(CORE_LOOP_V2_POLICY.textLimits)).toBe(true);
  });

  it("accepts only the two interview languages and rejects mixed union variants", () => {
    expect(interviewLanguageSchema.safeParse("zh-CN").success).toBe(true);
    expect(interviewLanguageSchema.safeParse("en-US").success).toBe(true);
    expect(interviewLanguageSchema.safeParse("zh-TW").success).toBe(false);
    expect(
      attackChainCandidateSchema.safeParse({
        status: "needs_input",
        intent: "ownership_claim_depth",
        reasonCode: "no_claim_evidence",
        requestedEvidence: [{ kind: "decision", prompt: "Add a decision." }],
        knowledgeTarget: "must not exist",
      }).success,
    ).toBe(false);
  });
});

describe("ProviderView grounding", () => {
  it("materializes exact local excerpts and structure-aware bounded context", () => {
    const result = materialize({
      evidenceAnchors: [
        { source: "resume", startLine: 3, endLine: 4 },
        { source: "project_notes", startLine: 3, endLine: 3 },
      ],
    });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    const chain = result.record.plan.attackChains[0];
    expect(chain).toMatchObject({
      status: "ready",
      evidenceAnchors: [
        { source: "resume", excerpt: "Owned the queue migration\nReduced failures by 35%" },
        { source: "project_notes", excerpt: "Made the retry decision" },
      ],
    });
    expect(result.record.questionContext).toMatchObject({
      totalLines: expect.any(Number),
      totalCharacters: expect.any(Number),
    });
    expect(result.record.questionContext!.totalLines).toBeLessThanOrEqual(24);
    expect(result.record.questionContext!.lines.map((line) => line.text)).not.toContain(
      "Other project",
    );
  });

  it.each([
    {
      name: "reversed range",
      overrides: { evidenceAnchors: [{ source: "resume", startLine: 4, endLine: 3 }] },
      reason: "anchor_range_invalid",
    },
    {
      name: "out of bounds range",
      overrides: { evidenceAnchors: [{ source: "resume", startLine: 99, endLine: 99 }] },
      reason: "anchor_range_invalid",
    },
    {
      name: "inconsistent target signals",
      overrides: {
        difficultyBasis: { signals: ["explicit_scope"], explanation: "Scope only." },
      },
      reason: "difficulty_basis_inconsistent",
    },
    {
      name: "inconsistent stretch signals",
      overrides: {
        initialDifficulty: "stretch",
        difficultyBasis: {
          signals: ["system_scope"],
          explanation: "System scope without a decision.",
        },
      },
      reason: "difficulty_basis_inconsistent",
    },
  ])("rejects $name as a semantic candidate", ({ overrides, reason }) => {
    expect(materialize(overrides)).toEqual({ status: "rejected", reason });
  });

  it("rejects blank or redaction-only evidence", () => {
    const redactedView = { ...providerView, resume: "Email: [REDACTED_EMAIL]" };
    const candidate = attackChainCandidateSchema.parse({
      status: "ready",
      intent: "ownership_claim_depth",
      knowledgeTarget: "Verify ownership",
      evidenceAnchors: [{ source: "resume", startLine: 1, endLine: 1 }],
      initialDifficulty: "baseline",
      difficultyBasis: { signals: ["limited_detail"], explanation: "Limited detail." },
      estimatedDepth: 1,
    });
    expect(
      materializeInterviewPlanCandidate({
        candidate,
        providerView: redactedView,
        generation: { ...generation, contractVersion: "interview-plan-v1" },
        policy: createCoreLoopPolicySnapshot(),
        createId: ids(),
        createdAt: "2026-09-04T08:00:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "anchor_has_no_evidence" });
  });

  it("measures all planning fields without silently truncating them", () => {
    const oversized = { ...providerView, resume: "x".repeat(24_001) };
    expect(measurePlanningInput(oversized)).toMatchObject({
      resume: 24_001,
      total: expect.any(Number),
    });
    expect(measurePlanningInput(oversized).total).toBeGreaterThan(24_000);
  });

  it("crops a large structural section around the evidence under both packet limits", () => {
    const longLines = Array.from({ length: 35 }, (_, index) =>
      index === 19 ? "Owned the central migration decision" : `${index + 1} ${"context ".repeat(55)}`,
    );
    const largeView = { ...providerView, projectNotes: `# Large project\n${longLines.join("\n")}` };
    const candidate = attackChainCandidateSchema.parse({
      status: "ready",
      intent: "ownership_claim_depth",
      knowledgeTarget: "Verify the migration decision",
      evidenceAnchors: [{ source: "project_notes", startLine: 21, endLine: 21 }],
      initialDifficulty: "target",
      difficultyBasis: {
        signals: ["explicit_decision"],
        explanation: "A concrete decision is present.",
      },
      estimatedDepth: 2,
    });
    const result = materializeInterviewPlanCandidate({
      candidate,
      providerView: largeView,
      generation: { ...generation, contractVersion: "interview-plan-v1" },
      policy: createCoreLoopPolicySnapshot(),
      createId: ids(),
      createdAt: "2026-09-04T08:00:00.000Z",
    });
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.record.questionContext).toMatchObject({
      totalLines: expect.any(Number),
      totalCharacters: expect.any(Number),
    });
    expect(result.record.questionContext!.totalLines).toBeLessThanOrEqual(24);
    expect(result.record.questionContext!.totalCharacters).toBeLessThanOrEqual(4_000);
    expect(result.record.questionContext!.lines.map((line) => line.text)).toContain(
      "Owned the central migration decision",
    );
  });
});

describe("AttackChainExecution Module", () => {
  const chain: ReadyAttackChain = {
    id: "chain-1",
    status: "ready",
    intent: "ownership_claim_depth",
    knowledgeTarget: "Verify ownership",
    evidenceAnchors: [
      { id: "anchor-1", source: "resume", startLine: 3, endLine: 3, excerpt: "Owned it" },
    ],
    initialDifficulty: "target",
    difficultyBasis: {
      signals: ["explicit_decision"],
      explanation: "A decision is explicit.",
    },
    estimatedDepth: 2,
  };

  function ask(state = createAttackChainExecutionState(chain.id), text = "What did you decide?") {
    return acceptNextQuestionCandidate({
      state,
      chain,
      candidate: {
        status: "ask",
        question: { text, difficulty: "target", evidenceAnchorIds: ["anchor-1"] },
      },
      generation,
      policy: createCoreLoopPolicySnapshot(),
      questionTurnId: "turn-1",
      now: "2026-09-04T08:00:00.000Z",
    });
  }

  it("counts a QuestionTurn only when a question is accepted for display", () => {
    const result = ask();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.state.turns).toHaveLength(1);
    expect(result.state.answerMode).toBe("a2a");
    expect(result.state.turns[0]).toMatchObject({
      id: "turn-1",
      ordinal: 1,
      status: "awaiting_answer",
    });
    expect(result.events).toHaveLength(1);
  });

  it("takes over the current turn without increasing depth and keeps A2H sticky", () => {
    const presented = ask();
    if (presented.status !== "accepted") throw new Error("question was not accepted");
    const takenOver = takeOverQuestionTurn(presented.state);
    if (takenOver.status !== "accepted") throw new Error("control was not taken over");
    expect(takenOver.state).toMatchObject({ answerMode: "a2h", turns: [{ id: "turn-1" }] });
    expect(takenOver.state.turns).toHaveLength(1);
    expect(takenOver.events).toEqual([
      {
        type: "control_taken_over",
        payload: {
          chainId: "chain-1",
          turnId: "turn-1",
          from: "candidate",
          to: "human",
        },
      },
    ]);

    expect(
      settleQuestionTurn({
        state: takenOver.state,
        questionTurnId: "turn-1",
        actor: "candidate",
        answer: "The Candidate no longer controls this chain.",
        generation: candidateGeneration,
        now: "2026-09-04T08:01:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "answer_actor_mismatch" });

    const settled = settleQuestionTurn({
      state: takenOver.state,
      questionTurnId: "turn-1",
      actor: "human",
      answer: "  I selected idempotent retries.  ",
      now: "2026-09-04T08:01:00.000Z",
    });
    if (settled.status !== "accepted") throw new Error("human answer was not accepted");
    const next = acceptNextQuestionCandidate({
      state: settled.state,
      chain,
      candidate: {
        status: "ask",
        question: {
          text: "What tradeoff did that introduce?",
          difficulty: "target",
          evidenceAnchorIds: ["anchor-1"],
        },
      },
      generation,
      policy: createCoreLoopPolicySnapshot(),
      questionTurnId: "turn-2",
      now: "2026-09-04T08:02:00.000Z",
    });
    expect(next).toMatchObject({
      status: "accepted",
      state: { answerMode: "a2h", status: "awaiting_answer" },
    });
  });

  it("keeps Candidate generation internal while projecting only actor and text", () => {
    const presented = ask();
    if (presented.status !== "accepted") throw new Error("question was not accepted");
    const settled = settleQuestionTurn({
      state: presented.state,
      questionTurnId: "turn-1",
      actor: "candidate",
      answer: "I owned the migration decision.",
      generation: candidateGeneration,
      now: "2026-09-04T08:01:00.000Z",
    });
    if (settled.status !== "accepted") throw new Error("answer was not accepted");
    expect(settled.state.turns[0].answer).toMatchObject({
      actor: "candidate",
      generation: { contractVersion: "candidate-answer-v1" },
    });
    expect(publicQuestionTurnSchema.parse(settled.state.turns[0]).answer).toEqual({
      actor: "candidate",
      text: "I owned the migration decision.",
    });
  });

  it("measures the answer limit by Unicode characters", () => {
    expect(answerTextSchema.safeParse(` ${"🙂".repeat(4_000)} `).success).toBe(true);
    expect(answerTextSchema.safeParse("🙂".repeat(4_001)).success).toBe(false);
    expect(answerTextSchema.safeParse("   ").success).toBe(false);
  });

  it("settles the same stable turn and permits a model-driven early completion", () => {
    const presented = ask();
    if (presented.status !== "accepted") throw new Error("question was not accepted");
    const takenOver = takeOverQuestionTurn(presented.state);
    if (takenOver.status !== "accepted") throw new Error("control was not taken over");
    const settled = settleQuestionTurn({
      state: takenOver.state,
      questionTurnId: "turn-1",
      actor: "human",
      answer: "I selected idempotent retries.",
      now: "2026-09-04T08:01:00.000Z",
    });
    if (settled.status !== "accepted") throw new Error("turn was not settled");
    const completed = acceptNextQuestionCandidate({
      state: settled.state,
      chain,
      candidate: {
        status: "complete",
        code: "knowledge_target_satisfied",
        explanation: "The ownership target is satisfied.",
      },
      generation,
      policy: createCoreLoopPolicySnapshot(),
      questionTurnId: "unused",
      now: "2026-09-04T08:02:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "accepted",
      state: { status: "completed", turns: [{ id: "turn-1", status: "settled" }] },
    });
  });

  it("completes deterministically at planned depth without another candidate", () => {
    const depthOneChain = { ...chain, estimatedDepth: 1 as const };
    const presented = ask();
    if (presented.status !== "accepted") throw new Error("question was not accepted");
    const settled = settleQuestionTurn({
      state: presented.state,
      questionTurnId: "turn-1",
      actor: "candidate",
      answer: "Synthetic answer",
      generation: candidateGeneration,
      now: "2026-09-04T08:01:00.000Z",
    });
    if (settled.status !== "accepted") throw new Error("turn was not settled");
    expect(
      completeAtPlannedDepth({
        state: settled.state,
        chain: depthOneChain,
        policy: createCoreLoopPolicySnapshot(),
        interviewLanguage: "zh-CN",
        now: "2026-09-04T08:02:00.000Z",
      }),
    ).toMatchObject({
      status: "accepted",
      state: { status: "completed", completion: { code: "planned_depth_reached" } },
    });
  });

  it("rejects duplicate normalized questions, unknown evidence, and invalid difficulty jumps", () => {
    const presented = ask();
    if (presented.status !== "accepted") throw new Error("question was not accepted");
    const readyState = {
      ...presented.state,
      status: "ready_for_next_question" as const,
      turns: [{
        ...presented.state.turns[0],
        status: "settled" as const,
        settledAt: "2026-09-04T08:01:00.000Z",
        answer: {
          actor: "candidate" as const,
          text: "Answer",
          generation: candidateGeneration,
        },
      }],
    };
    expect(ask(readyState, "  WHAT did you decide？！ ")).toEqual({
      status: "rejected",
      reason: "duplicate_question",
    });
    expect(
      acceptNextQuestionCandidate({
        state: readyState,
        chain,
        candidate: {
          status: "ask",
          question: { text: "What changed?", difficulty: "target", evidenceAnchorIds: ["missing"] },
        },
        generation,
        policy: createCoreLoopPolicySnapshot(),
        questionTurnId: "turn-2",
        now: "2026-09-04T08:02:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "unknown_evidence_anchor" });
    expect(
      acceptNextQuestionCandidate({
        state: readyState,
        chain,
        candidate: {
          status: "ask",
          question: { text: "What changed?", difficulty: "baseline", evidenceAnchorIds: ["anchor-1"] },
        },
        generation,
        policy: createCoreLoopPolicySnapshot(),
        questionTurnId: "turn-2",
        now: "2026-09-04T08:02:00.000Z",
      }).status,
    ).toBe("accepted");
    const stretchState = {
      ...readyState,
      turns: [
        {
          ...readyState.turns[0],
          question: { ...readyState.turns[0].question, difficulty: "stretch" as const },
        },
      ],
    };
    expect(
      acceptNextQuestionCandidate({
        state: stretchState,
        chain,
        candidate: {
          status: "ask",
          question: {
            text: "Return to the basics?",
            difficulty: "baseline",
            evidenceAnchorIds: ["anchor-1"],
          },
        },
        generation,
        policy: createCoreLoopPolicySnapshot(),
        questionTurnId: "turn-2",
        now: "2026-09-04T08:02:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "difficulty_step_too_large" });
  });

  it("rejects model completion before any answer and refuses a fifth formal question", () => {
    expect(
      acceptNextQuestionCandidate({
        state: createAttackChainExecutionState(chain.id),
        chain,
        candidate: {
          status: "complete",
          code: "no_grounded_followup",
          explanation: "No follow-up remains.",
        },
        generation,
        policy: createCoreLoopPolicySnapshot(),
        questionTurnId: "unused",
        now: "2026-09-04T08:00:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "complete_before_answer" });

    let state = createAttackChainExecutionState(chain.id);
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      const presented = acceptNextQuestionCandidate({
        state,
        chain: { ...chain, estimatedDepth: 4 },
        candidate: {
          status: "ask",
          question: {
            text: `Unique question ${ordinal}?`,
            difficulty: "target",
            evidenceAnchorIds: ["anchor-1"],
          },
        },
        generation,
        policy: createCoreLoopPolicySnapshot(),
        questionTurnId: `turn-${ordinal}`,
        now: `2026-09-04T08:0${ordinal}:00.000Z`,
      });
      if (presented.status !== "accepted") throw new Error("question was not accepted");
      const settled = settleQuestionTurn({
        state: presented.state,
        questionTurnId: `turn-${ordinal}`,
        actor: "candidate",
        answer: `Answer ${ordinal}`,
        generation: candidateGeneration,
        now: `2026-09-04T08:1${ordinal}:00.000Z`,
      });
      if (settled.status !== "accepted") throw new Error("answer was not settled");
      state = settled.state;
    }
    expect(
      acceptNextQuestionCandidate({
        state,
        chain: { ...chain, estimatedDepth: 4 },
        candidate: {
          status: "ask",
          question: {
            text: "A forbidden fifth question?",
            difficulty: "target",
            evidenceAnchorIds: ["anchor-1"],
          },
        },
        generation,
        policy: createCoreLoopPolicySnapshot(),
        questionTurnId: "turn-5",
        now: "2026-09-04T08:20:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "question_turn_limit_reached" });
  });

  it("uses question-v1 normalization while preserving internal code punctuation", () => {
    expect(normalizeQuestionV1("  ＷＨＡＴ   about foo::bar()？！ ")).toBe(
      "what about foo::bar()",
    );
  });
});
