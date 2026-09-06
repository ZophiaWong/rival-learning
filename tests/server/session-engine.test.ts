import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInterviewAgents } from "@/server/interview-agents";
import type { ModelAttempt } from "@/server/interview-agents/role-runner";
import {
  ScriptedRoleRunner,
  type ScriptedRoleRunStep,
} from "@/server/interview-agents/role-runner/scripted";
import {
  createPreparationProfiles,
  type PreparationProfiles,
} from "@/server/preparation-profiles";
import { migrateDatabase } from "@/server/persistence/migrate";
import { createSessionEngine, type SessionEngine } from "@/server/session-engine";

function attempt(number = 1): ModelAttempt {
  return {
    attempt: number,
    providerId: "openrouter",
    model: "synthetic/interviewer",
    outcome: "succeeded",
    httpStatus: 200,
    requestId: `request-${number}`,
    durationMs: 10,
    inputTokens: 20,
    outputTokens: 10,
  };
}

function readyPlan(
  anchor = { source: "resume", startLine: 1, endLine: 1 },
  estimatedDepth = 3,
) {
  return {
    status: "success" as const,
    value: {
      outcome: {
        status: "ready",
        intent: "ownership_claim_depth",
        knowledgeTarget: "Verify ownership and decision depth",
        evidenceAnchors: [anchor],
        initialDifficulty: "target",
        difficultyBasis: {
          signals: ["quantified_outcome"],
          explanation: "The claim contains a quantified outcome.",
        },
        estimatedDepth,
      },
    },
    attempts: [attempt()],
  };
}

function candidateAnswer(text = "I chose idempotent retries and owned the rollback decision.") {
  return {
    status: "success" as const,
    value: { outcome: { text } },
    attempts: [{ ...attempt(), model: "synthetic/candidate" }],
  };
}

function nextQuestion(text: string): ScriptedRoleRunStep {
  return (request) => {
    const input = JSON.parse(request.input) as {
      plan: { attackChains: [{ evidenceAnchors: Array<{ id: string }> }] };
    };
    return {
      status: "success",
      value: {
        outcome: {
          status: "ask",
          question: {
            text,
            difficulty: "target",
            evidenceAnchorIds: [input.plan.attackChains[0].evidenceAnchors[0].id],
          },
        },
      },
      attempts: [attempt()],
    };
  };
}

function completeQuestionChain(): ScriptedRoleRunStep {
  return {
    status: "success",
    value: {
      outcome: {
        status: "complete",
        code: "knowledge_target_satisfied",
        explanation: "The settled transcript now establishes ownership and decision depth.",
      },
    },
    attempts: [attempt()],
  };
}

function firstQuestion(): ScriptedRoleRunStep {
  return (request) => {
    const input = JSON.parse(request.input) as {
      plan: { attackChains: [{ evidenceAnchors: Array<{ id: string }> }] };
    };
    return {
      status: "success",
      value: {
        outcome: {
          status: "ask",
          question: {
            text: "What did you personally decide?",
            difficulty: "target",
            evidenceAnchorIds: [input.plan.attackChains[0].evidenceAnchors[0].id],
          },
        },
      },
      attempts: [attempt()],
    };
  };
}

describe("SessionEngine.dispatch Interface", () => {
  let directory: string;
  let databasePath: string;
  let profiles: PreparationProfiles;
  let engine: SessionEngine;
  let entitySequence: number;
  let operationSequence: number;

  function createEngine(steps: ScriptedRoleRunStep[]): SessionEngine {
    return createSessionEngine({
      databasePath,
      preparationProfiles: profiles,
      interviewAgents: createInterviewAgents(new ScriptedRoleRunner(steps)),
      createOperationToken: () => `operation-${++operationSequence}`,
      createEntityId: () => `entity-${++entitySequence}`,
      now: () => new Date("2026-09-04T08:00:00.000Z"),
    });
  }

  function reopen(steps: ScriptedRoleRunStep[]): void {
    engine.close();
    engine = createEngine(steps);
  }

  function confirmedProfile(resume = "Owned a queue migration and reduced failures by 35%.") {
    const profile = profiles.create({
      name: "Backend preparation",
      resume,
      projectNotes: "# Queue\nSelected idempotent retries.",
      jobDescription: "Own distributed backend services.",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    return profile;
  }

  async function createSession(language: "zh-CN" | "en-US" = "en-US") {
    const profile = confirmedProfile();
    return engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      interviewLanguage: language,
      idempotencyKey: "create-1",
    });
  }

  async function startFlow(
    extraSteps: ScriptedRoleRunStep[] = [],
    estimatedDepth = 3,
    language: "zh-CN" | "en-US" = "en-US",
  ): Promise<void> {
    await createSession(language);
    reopen([
      readyPlan({ source: "resume", startLine: 1, endLine: 1 }, estimatedDepth),
      firstQuestion(),
      ...extraSteps,
    ]);
    await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    const started = await engine.dispatch({
      type: "start",
      sessionId: "session-1",
      idempotencyKey: "start-1",
    });
    expect(started).toMatchObject({ status: "applied" });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rival-learning-session-engine-"));
    databasePath = join(directory, "app.db");
    migrateDatabase(databasePath);
    entitySequence = 0;
    operationSequence = 0;
    profiles = createPreparationProfiles({
      databasePath,
      createId: () => `profile-${++entitySequence}`,
      now: () => new Date("2026-09-04T08:00:00.000Z"),
    });
    engine = createEngine([]);
  });

  afterEach(() => {
    engine.close();
    profiles.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates a language-specific Session only from a confirmed ProviderView", async () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Email: candidate@example.com\nOwned the original queue migration",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    const rejected = await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      interviewLanguage: "zh-CN",
      idempotencyKey: "create-1",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      error: { code: "provider_view_not_confirmed" },
    });

    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    const created = await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      interviewLanguage: "zh-CN",
      idempotencyKey: "create-2",
    });
    const replay = await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      interviewLanguage: "zh-CN",
      idempotencyKey: "create-2",
    });
    expect(created).toMatchObject({
      status: "applied",
      session: {
        status: "draft",
        state: { interviewLanguage: "zh-CN", plan: null, activeOperation: null },
        profileSnapshot: {
          profile: { resume: expect.stringContaining("original queue") },
          providerView: { resume: expect.not.stringContaining("candidate@example.com") },
        },
      },
      events: [
        { type: "session_created", payload: { interviewLanguage: "zh-CN" } },
      ],
    });
    expect(replay).toEqual(created);
  });

  it("plans outside the transaction and starts by atomically presenting the first question", async () => {
    await createSession();
    let externalWriteSucceeded = false;
    reopen([
      (request) => {
        expect(request.onOutputDelta).toBeUndefined();
        expect(JSON.parse(request.input)).toMatchObject({
          providerView: { resume: expect.stringContaining("35%") },
        });
        const secondConnection = new Database(databasePath);
        secondConnection.pragma("busy_timeout = 0");
        secondConnection
          .prepare("update sessions set updated_at = updated_at where id = ?")
          .run("session-1");
        secondConnection.close();
        externalWriteSucceeded = true;
        return readyPlan();
      },
      firstQuestion(),
    ]);

    const planned = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    const started = await engine.dispatch({
      type: "start",
      sessionId: "session-1",
      idempotencyKey: "start-1",
    });

    expect(externalWriteSucceeded).toBe(true);
    expect(planned).toMatchObject({
      status: "applied",
      session: {
        status: "planned",
        state: {
          plan: {
            attackChains: [
              {
                status: "ready",
                knowledgeTarget: "Verify ownership and decision depth",
                evidenceAnchors: [{ excerpt: expect.stringContaining("35%") }],
              },
            ],
          },
        },
      },
      events: [
        { type: "operation_started", payload: { operation: "generate_plan" } },
        {
          type: "interview_plan_generated",
          payload: {
            status: "ready",
            generation: { usage: { requests: 1, inputTokens: 20, outputTokens: 10 } },
          },
        },
      ],
    });
    expect(started).toMatchObject({
      status: "applied",
      session: {
        status: "active",
        state: {
          execution: {
            status: "awaiting_answer",
            turns: [
              {
                ordinal: 1,
                status: "awaiting_answer",
                question: { text: "What did you personally decide?", difficulty: "target" },
              },
            ],
          },
        },
      },
      events: [
        { type: "operation_started", payload: { operation: "start" } },
        { type: "session_started" },
        { type: "question_presented" },
      ],
    });
    const publicJson = JSON.stringify(started);
    expect(publicJson).not.toContain("normalizationKey");
    expect(publicJson).not.toContain("questionContext");
    expect(publicJson).not.toContain("operationToken");
    expect(engine.timeline("session-1").map((event) => event.type)).toEqual([
      "session_created",
      "operation_started",
      "interview_plan_generated",
      "operation_started",
      "session_started",
      "question_presented",
    ]);
  });

  it("stores needs_input as a successful plan and refuses to start it", async () => {
    await createSession();
    reopen([
      {
        status: "success",
        value: {
          outcome: {
            status: "needs_input",
            intent: "ownership_claim_depth",
            reasonCode: "claim_too_vague",
            requestedEvidence: [
              { kind: "decision", prompt: "Add a decision you personally made." },
            ],
          },
        },
        attempts: [attempt()],
      },
    ]);
    const planned = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    const started = await engine.dispatch({
      type: "start",
      sessionId: "session-1",
      idempotencyKey: "start-1",
    });
    expect(planned).toMatchObject({
      status: "applied",
      session: { state: { plan: { attackChains: [{ status: "needs_input" }] } } },
    });
    expect(started).toMatchObject({
      status: "rejected",
      error: { code: "attack_chain_needs_input" },
    });
    expect(engine.timeline("session-1").map((event) => event.type)).not.toContain(
      "session_started",
    );
  });

  it("shares three semantic plan candidates across different rejection reasons", async () => {
    await createSession();
    reopen([
      readyPlan({ source: "resume", startLine: 99, endLine: 99 }),
      readyPlan({ source: "resume", startLine: 2, endLine: 1 }),
      readyPlan(),
    ]);
    const result = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    expect(result).toMatchObject({
      status: "applied",
      events: [
        { type: "operation_started" },
        {
          type: "interview_plan_generated",
          payload: { generation: { usage: { requests: 3, inputTokens: 60, outputTokens: 30 } } },
        },
      ],
    });
  });

  it("records safe rejection counts when question candidates are exhausted", async () => {
    await createSession("zh-CN");
    reopen([
      readyPlan(),
      ...Array.from({ length: 3 }, () => ({
        status: "success" as const,
        value: {
          outcome: {
            status: "ask",
            question: {
              text: "A baseline question",
              difficulty: "baseline",
              evidenceAnchorIds: ["unknown-anchor"],
            },
          },
        },
        attempts: [attempt()],
      })),
    ]);
    await engine.dispatch({ type: "generate_plan", sessionId: "session-1", idempotencyKey: "plan-1" });
    const result = await engine.dispatch({
      type: "start",
      sessionId: "session-1",
      idempotencyKey: "start-1",
    });
    expect(result).toMatchObject({
      status: "rejected",
      error: {
        code: "semantic_candidates_exhausted",
        retryable: true,
        details: {
          rejectionCounts: {
            first_question_difficulty_mismatch: 3,
          },
          lastRejectionReason: "first_question_difficulty_mismatch",
        },
      },
    });
    expect(engine.get("session-1")).toMatchObject({
      status: "error",
      state: {
        activeOperation: null,
        failedOperation: {
          code: "semantic_candidates_exhausted",
          retrySafety: "safe_to_retry",
        },
      },
    });
    expect(engine.timeline("session-1").at(-1)).toMatchObject({
      type: "operation_failed",
      payload: {
        operation: "start",
        code: "semantic_candidates_exhausted",
        usage: { requests: 3 },
      },
    });
  });

  it("returns input_too_large with safe field sizes and never calls the model", async () => {
    const profile = confirmedProfile("x".repeat(24_001));
    await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      interviewLanguage: "en-US",
      idempotencyKey: "create-1",
    });
    const result = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    expect(result).toMatchObject({
      status: "rejected",
      error: {
        code: "input_too_large",
        retryable: false,
        details: { fieldSizes: { resume: 24_001, total: expect.any(Number) } },
      },
    });
    expect(engine.timeline("session-1").at(-1)).toMatchObject({
      type: "operation_failed",
      payload: { usage: { requests: 0 } },
    });
  });

  it("serializes concurrent operations without consuming the losing idempotency key", async () => {
    await createSession();
    let enteredResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    reopen([
      async () => {
        enteredResolve();
        await release;
        return readyPlan();
      },
    ]);
    const first = engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    await entered;
    const concurrent = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-2",
    });
    releaseResolve();
    const applied = await first;
    const replay = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    expect(concurrent).toMatchObject({ status: "rejected", error: { code: "session_busy" } });
    expect(applied).toMatchObject({ status: "applied" });
    expect(replay).toEqual(applied);
    await expect(
      engine.dispatch({
        type: "generate_plan",
        sessionId: "session-1",
        idempotencyKey: "plan-2",
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "invalid_session_state" } });
  });

  it("recovers an interrupted reservation into explicit failedOperation facts", async () => {
    await createSession();
    let enteredResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    reopen([
      async () => {
        enteredResolve();
        await release;
        return readyPlan();
      },
    ]);
    const interruptedEngine = engine;
    const pending = interruptedEngine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    await entered;
    engine = createEngine([]);
    expect(engine.get("session-1")).toMatchObject({
      status: "error",
      state: {
        failedOperation: {
          type: "generate_plan",
          priorPhase: "draft",
          code: "operation_interrupted",
          retrySafety: "safe_to_retry",
        },
      },
    });
    releaseResolve();
    await expect(pending).resolves.toMatchObject({
      status: "rejected",
      error: { code: "operation_conflict" },
    });
    interruptedEngine.close();
  });

  it("preserves a provider failure as a localized, recoverable operation failure", async () => {
    await createSession("en-US");
    reopen([
      {
        status: "failure",
        error: { code: "provider_timeout", message: "private provider detail" },
        attempts: [{ ...attempt(), outcome: "timeout", httpStatus: null }],
      },
    ]);
    const result = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "provider_timeout", retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain("private provider detail");
    expect(engine.timeline("session-1").at(-1)).toMatchObject({
      type: "operation_failed",
      payload: { code: "provider_timeout", retryable: true, usage: { requests: 1 } },
    });
  });

  it("runs Candidate answer, next question, Take Over, and sticky A2H to completion", async () => {
    let finalQuestionPayload: Record<string, unknown> | undefined;
    await startFlow([
      candidateAnswer(),
      nextQuestion("Why was idempotent retry the right tradeoff?"),
      (request) => {
        finalQuestionPayload = JSON.parse(request.input) as Record<string, unknown>;
        const plan = finalQuestionPayload.plan as {
          attackChains: [{ evidenceAnchors: Array<{ id: string }> }];
        };
        return {
          status: "success",
          value: {
            outcome: {
              status: "ask",
              question: {
                text: "Which signals would trigger rollback?",
                difficulty: "target",
                evidenceAnchorIds: [plan.attackChains[0].evidenceAnchors[0].id],
              },
            },
          },
          attempts: [attempt()],
        };
      },
    ]);

    const candidate = await engine.dispatch({
      type: "request_ai_answer",
      sessionId: "session-1",
      idempotencyKey: "candidate-1",
    });
    expect(candidate).toMatchObject({
      status: "applied",
      session: {
        state: {
          execution: {
            answerMode: "a2a",
            status: "ready_for_next_question",
            turns: [
              {
                ordinal: 1,
                answer: { actor: "candidate", text: expect.stringContaining("idempotent") },
              },
            ],
          },
        },
      },
      events: [
        { type: "operation_started", payload: { operation: "request_ai_answer" } },
        {
          type: "answer_recorded",
          payload: {
            actor: "candidate",
            generation: { contractVersion: "candidate-answer-v1" },
          },
        },
      ],
    });
    if (candidate.status !== "applied") throw new Error("Candidate answer was not applied");
    expect(JSON.stringify(candidate.session)).not.toContain("candidate-answer-v1");

    await expect(
      engine.dispatch({
        type: "request_next_question",
        sessionId: "session-1",
        idempotencyKey: "question-2",
      }),
    ).resolves.toMatchObject({
      status: "applied",
      session: { state: { execution: { turns: [{}, { ordinal: 2 }] } } },
    });
    const takenOver = await engine.dispatch({
      type: "take_over",
      sessionId: "session-1",
      idempotencyKey: "take-over-1",
    });
    expect(takenOver).toMatchObject({
      status: "applied",
      session: { state: { execution: { answerMode: "a2h", turns: [{}, {}] } } },
      events: [
        {
          type: "control_taken_over",
          payload: { from: "candidate", to: "human" },
        },
      ],
    });

    await engine.dispatch({
      type: "submit_human_answer",
      sessionId: "session-1",
      answer: "I would compare duplicate risk, recovery time, and operational cost.",
      idempotencyKey: "human-2",
    });
    await engine.dispatch({
      type: "request_next_question",
      sessionId: "session-1",
      idempotencyKey: "question-3",
    });
    expect(finalQuestionPayload?.publicTranscript).toEqual([
      {
        question: "What did you personally decide?",
        answer: {
          actor: "candidate",
          text: "I chose idempotent retries and owned the rollback decision.",
        },
      },
      {
        question: "Why was idempotent retry the right tradeoff?",
        answer: {
          actor: "human",
          text: "I would compare duplicate risk, recovery time, and operational cost.",
        },
      },
    ]);
    const completed = await engine.dispatch({
      type: "submit_human_answer",
      sessionId: "session-1",
      answer: "I would roll back on sustained duplicate growth or latency regression.",
      idempotencyKey: "human-3",
    });
    expect(completed).toMatchObject({
      status: "applied",
      session: {
        state: {
          execution: {
            answerMode: "a2h",
            status: "completed",
            turns: [
              { answer: { actor: "candidate" } },
              { answer: { actor: "human" } },
              { answer: { actor: "human" } },
            ],
            completion: { code: "planned_depth_reached" },
          },
        },
      },
      events: [{ type: "answer_recorded" }, { type: "attack_chain_completed" }],
    });

    const timeline = engine.timeline("session-1");
    expect(timeline.filter((event) => event.type === "question_presented")).toHaveLength(3);
    expect(timeline.filter((event) => event.type === "answer_recorded")).toHaveLength(3);
    expect(timeline.filter((event) => event.type === "control_taken_over")).toHaveLength(1);
    expect(timeline.filter((event) => event.type === "attack_chain_completed")).toHaveLength(1);
    expect(
      timeline
        .filter((event) =>
          [
            "question_presented",
            "answer_recorded",
            "control_taken_over",
            "attack_chain_completed",
          ].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual([
      "question_presented",
      "answer_recorded",
      "question_presented",
      "control_taken_over",
      "answer_recorded",
      "question_presented",
      "answer_recorded",
      "attack_chain_completed",
    ]);
    const persisted = new Database(databasePath, { readonly: true });
    const persistedRow = persisted
      .prepare("select state_json from sessions where id = ?")
      .get("session-1") as { state_json: string };
    persisted.close();
    const persistedState = JSON.parse(persistedRow.state_json) as {
      stateVersion: number;
      execution: {
        turns: Array<{ answer: { actor: string; generation?: { contractVersion: string } } }>;
      };
    };
    expect(persistedState.stateVersion).toBe(3);
    expect(persistedState.execution.turns[0].answer).toMatchObject({
      actor: "candidate",
      generation: { contractVersion: "candidate-answer-v1" },
    });
    expect(persistedState.execution.turns[1].answer).toEqual({
      actor: "human",
      text: "I would compare duplicate risk, recovery time, and operational cost.",
    });
    const beforeRestart = engine.get("session-1");
    reopen([]);
    expect(engine.get("session-1")).toEqual(beforeRestart);
    expect(engine.timeline("session-1")).toEqual(timeline);
  });

  it("completes in the same answer transaction at planned depth", async () => {
    await startFlow([candidateAnswer()], 1);
    const depthCompletion = await engine.dispatch({
      type: "request_ai_answer",
      sessionId: "session-1",
      idempotencyKey: "candidate-1",
    });
    expect(depthCompletion).toMatchObject({
      status: "applied",
      session: { state: { execution: { status: "completed" } } },
      events: [{ type: "operation_started" }, { type: "answer_recorded" }, { type: "attack_chain_completed" }],
    });
    await expect(
      engine.dispatch({
        type: "request_next_question",
        sessionId: "session-1",
        idempotencyKey: "question-after-complete",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "request_next_question_not_available",
        details: { reason: "attack_chain_completed" },
      },
    });
  });

  it("accepts grounded Interviewer completion before the planned depth", async () => {
    await startFlow([candidateAnswer(), completeQuestionChain()], 4);
    await engine.dispatch({
      type: "request_ai_answer",
      sessionId: "session-1",
      idempotencyKey: "candidate-1",
    });
    await expect(
      engine.dispatch({
        type: "request_next_question",
        sessionId: "session-1",
        idempotencyKey: "early-complete",
      }),
    ).resolves.toMatchObject({
      status: "applied",
      session: {
        state: {
          execution: {
            status: "completed",
            turns: [{ ordinal: 1 }],
            completion: { code: "knowledge_target_satisfied" },
          },
        },
      },
    });
  });

  it("stops at four settled turns without requesting a fifth question", async () => {
    await startFlow(
      [
        candidateAnswer("Answer 1"),
        nextQuestion("Unique question 2?"),
        candidateAnswer("Answer 2"),
        nextQuestion("Unique question 3?"),
        candidateAnswer("Answer 3"),
        nextQuestion("Unique question 4?"),
        candidateAnswer("Answer 4"),
      ],
      4,
    );
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      await expect(
        engine.dispatch({
          type: "request_ai_answer",
          sessionId: "session-1",
          idempotencyKey: `candidate-${ordinal}`,
        }),
      ).resolves.toMatchObject({ status: "applied" });
      if (ordinal < 4) {
        await expect(
          engine.dispatch({
            type: "request_next_question",
            sessionId: "session-1",
            idempotencyKey: `question-${ordinal + 1}`,
          }),
        ).resolves.toMatchObject({ status: "applied" });
      }
    }
    expect(engine.get("session-1")).toMatchObject({
      state: { execution: { status: "completed", turns: [{}, {}, {}, {}] } },
    });
    await expect(
      engine.dispatch({
        type: "request_next_question",
        sessionId: "session-1",
        idempotencyKey: "forbidden-question-5",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { details: { reason: "attack_chain_completed" } },
    });
  });

  it("allows Take Over after a Candidate failure while preserving the failure event", async () => {
    await startFlow([
      {
        status: "failure",
        error: { code: "provider_timeout", message: "private Candidate detail" },
        attempts: [{ ...attempt(), model: "synthetic/candidate", outcome: "timeout" }],
      },
    ]);
    await expect(
      engine.dispatch({
        type: "request_ai_answer",
        sessionId: "session-1",
        idempotencyKey: "candidate-1",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "provider_timeout" },
    });
    expect(engine.get("session-1")).toMatchObject({
      status: "error",
      state: { failedOperation: { type: "request_ai_answer" } },
    });

    const takenOver = await engine.dispatch({
      type: "take_over",
      sessionId: "session-1",
      idempotencyKey: "take-over-after-failure",
    });
    expect(takenOver).toMatchObject({
      status: "applied",
      session: {
        status: "active",
        state: {
          failedOperation: null,
          execution: { answerMode: "a2h", turns: [{ ordinal: 1 }] },
        },
      },
    });
    expect(engine.timeline("session-1").map((event) => event.type).slice(-2)).toEqual([
      "operation_failed",
      "control_taken_over",
    ]);
  });

  it("takes over the first question without adding a turn and validates human answers", async () => {
    await startFlow([], 2);
    const takenOver = await engine.dispatch({
      type: "take_over",
      sessionId: "session-1",
      idempotencyKey: "take-first",
    });
    expect(takenOver).toMatchObject({
      status: "applied",
      session: { state: { execution: { answerMode: "a2h", turns: [{ ordinal: 1 }] } } },
    });
    await expect(
      engine.dispatch({
        type: "submit_human_answer",
        sessionId: "session-1",
        answer: "   ",
        idempotencyKey: "empty-answer",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "invalid_human_answer", details: { reason: "empty" } },
    });
    await expect(
      engine.dispatch({
        type: "submit_human_answer",
        sessionId: "session-1",
        answer: "🙂".repeat(4_001),
        idempotencyKey: "long-answer",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "invalid_human_answer", details: { reason: "too_long" } },
    });
    await expect(
      engine.dispatch({
        type: "submit_human_answer",
        sessionId: "session-1",
        answer: "🙂".repeat(4_000),
        idempotencyKey: "boundary-answer",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(engine.get("session-1").state.execution?.turns).toHaveLength(1);
  });

  it("normalizes human-answer idempotency and rejects a reused key with different content", async () => {
    await startFlow([], 2);
    await engine.dispatch({
      type: "take_over",
      sessionId: "session-1",
      idempotencyKey: "take-over-1",
    });
    const original = await engine.dispatch({
      type: "submit_human_answer",
      sessionId: "session-1",
      answer: "  I owned the rollback decision.  ",
      idempotencyKey: "human-1",
    });
    const replay = await engine.dispatch({
      type: "submit_human_answer",
      sessionId: "session-1",
      answer: "I owned the rollback decision.",
      idempotencyKey: "human-1",
    });
    const conflict = await engine.dispatch({
      type: "submit_human_answer",
      sessionId: "session-1",
      answer: "I did something different.",
      idempotencyKey: "human-1",
    });
    expect(replay).toEqual(original);
    expect(conflict).toMatchObject({
      status: "rejected",
      error: { code: "idempotency_key_conflict" },
    });
    expect(engine.timeline("session-1").filter((event) => event.type === "answer_recorded")).toHaveLength(1);
  });

  it("returns stable action reasons across control and turn states", async () => {
    await createSession();
    await expect(
      engine.dispatch({ type: "take_over", sessionId: "session-1", idempotencyKey: "draft-take" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "take_over_not_available", details: { reason: "session_not_active" } },
    });

    reopen([readyPlan(), firstQuestion(), completeQuestionChain()]);
    await engine.dispatch({ type: "generate_plan", sessionId: "session-1", idempotencyKey: "plan-1" });
    await engine.dispatch({ type: "start", sessionId: "session-1", idempotencyKey: "start-1" });
    await expect(
      engine.dispatch({
        type: "request_next_question",
        sessionId: "session-1",
        idempotencyKey: "question-too-early",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "request_next_question_not_available", details: { reason: "answer_pending" } },
    });
    await expect(
      engine.dispatch({
        type: "submit_human_answer",
        sessionId: "session-1",
        answer: "Human answer before control",
        idempotencyKey: "human-too-early",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "submit_human_answer_not_available", details: { reason: "human_control_required" } },
    });
    await engine.dispatch({ type: "take_over", sessionId: "session-1", idempotencyKey: "take-1" });
    await expect(
      engine.dispatch({ type: "take_over", sessionId: "session-1", idempotencyKey: "take-2" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "take_over_not_available", details: { reason: "human_already_controls" } },
    });
    await expect(
      engine.dispatch({
        type: "request_ai_answer",
        sessionId: "session-1",
        idempotencyKey: "candidate-after-take",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "request_ai_answer_not_available", details: { reason: "candidate_control_required" } },
    });
    await engine.dispatch({
      type: "submit_human_answer",
      sessionId: "session-1",
      answer: "I owned the rollback decision.",
      idempotencyKey: "human-1",
    });
    await expect(
      engine.dispatch({ type: "take_over", sessionId: "session-1", idempotencyKey: "take-settled" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "take_over_not_available", details: { reason: "question_already_settled" } },
    });
    await expect(
      engine.dispatch({
        type: "submit_human_answer",
        sessionId: "session-1",
        answer: "A second answer",
        idempotencyKey: "human-settled",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "submit_human_answer_not_available", details: { reason: "question_already_settled" } },
    });
    await engine.dispatch({
      type: "request_next_question",
      sessionId: "session-1",
      idempotencyKey: "early-complete",
    });
    await expect(
      engine.dispatch({ type: "take_over", sessionId: "session-1", idempotencyKey: "take-complete" }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "take_over_not_available", details: { reason: "attack_chain_completed" } },
    });
  });

  it("does not consume a Take Over key while a Candidate operation owns the Session", async () => {
    let enteredResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    await startFlow([
      async () => {
        enteredResolve();
        await release;
        return candidateAnswer();
      },
    ]);
    const pending = engine.dispatch({
      type: "request_ai_answer",
      sessionId: "session-1",
      idempotencyKey: "candidate-1",
    });
    await entered;
    const busy = await engine.dispatch({
      type: "take_over",
      sessionId: "session-1",
      idempotencyKey: "take-during-operation",
    });
    expect(busy).toMatchObject({ status: "rejected", error: { code: "session_busy" } });
    releaseResolve();
    await expect(pending).resolves.toMatchObject({ status: "applied" });
    await expect(
      engine.dispatch({
        type: "take_over",
        sessionId: "session-1",
        idempotencyKey: "take-during-operation",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "take_over_not_available", details: { reason: "question_already_settled" } },
    });
  });

  it("recovers an interrupted Candidate operation and permits Take Over", async () => {
    let enteredResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    await startFlow([
      async () => {
        enteredResolve();
        await release;
        return candidateAnswer();
      },
    ]);
    const interruptedEngine = engine;
    const pending = interruptedEngine.dispatch({
      type: "request_ai_answer",
      sessionId: "session-1",
      idempotencyKey: "candidate-1",
    });
    await entered;
    engine = createEngine([]);
    expect(engine.get("session-1")).toMatchObject({
      status: "error",
      state: {
        failedOperation: { type: "request_ai_answer", code: "operation_interrupted" },
      },
    });
    await expect(
      engine.dispatch({
        type: "take_over",
        sessionId: "session-1",
        idempotencyKey: "take-after-interrupt",
      }),
    ).resolves.toMatchObject({
      status: "applied",
      session: { status: "active", state: { execution: { answerMode: "a2h" } } },
    });
    releaseResolve();
    await expect(pending).resolves.toMatchObject({
      status: "rejected",
      error: { code: "operation_conflict" },
    });
    interruptedEngine.close();
  });

  it("keeps a failed next-question operation terminal across new idempotency keys", async () => {
    await startFlow([
      candidateAnswer(),
      {
        status: "failure",
        error: { code: "provider_timeout", message: "private Interviewer detail" },
        attempts: [{ ...attempt(), outcome: "timeout" }],
      },
    ]);
    await engine.dispatch({
      type: "request_ai_answer",
      sessionId: "session-1",
      idempotencyKey: "candidate-1",
    });
    await expect(
      engine.dispatch({
        type: "request_next_question",
        sessionId: "session-1",
        idempotencyKey: "question-failure",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: { code: "provider_timeout" },
    });
    await expect(
      engine.dispatch({
        type: "request_next_question",
        sessionId: "session-1",
        idempotencyKey: "question-bypass-attempt",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "request_next_question_not_available",
        details: { reason: "session_in_error" },
      },
    });
    expect(
      engine.timeline("session-1").filter((event) => event.type === "operation_failed"),
    ).toHaveLength(1);
  });
});
