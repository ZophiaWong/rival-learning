import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInterviewAgents } from "@/server/interview-agents";
import { RUBRIC_DIMENSIONS } from "@/server/core-loop/domain";
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

function turnEvaluation(
  excerpt: string,
  partialDimension: (typeof RUBRIC_DIMENSIONS)[number],
): ScriptedRoleRunStep {
  return {
    status: "success",
    value: {
      outcome: {
        dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict: dimension === partialDimension ? "partial" : "met",
          rationale: "The answer is grounded but leaves one dimension incomplete.",
          answerExcerpts: [excerpt],
        })),
      },
    },
    attempts: [{ ...attempt(), model: "synthetic/judge" }],
  };
}

function benchmarkBatch(text = "I would validate measurable service outcomes."): ScriptedRoleRunStep {
  return (request) => {
    const input = JSON.parse(request.input) as {
      humanQuestions: Array<{ turnId: string; evidenceAnchorIds: string[] }>;
    };
    return {
      status: "success",
      value: {
        outcome: {
          benchmarks: input.humanQuestions.map((question) => ({
            turnId: question.turnId,
            text,
            evidenceAnchorIds: [question.evidenceAnchorIds[0]],
          })),
        },
      },
      attempts: [{ ...attempt(), model: "synthetic/candidate" }],
    };
  };
}

function checkpointReportWithNoFindings(): ScriptedRoleRunStep {
  return (request) => {
    const input = JSON.parse(request.input) as {
      humanTurns: Array<{ turnId: string }>;
    };
    return {
      status: "success",
      value: {
        outcome: {
          comparisons: input.humanTurns.map((turn) => ({
            turnId: turn.turnId,
            differences: [
              {
                dimension: "evidence_and_outcome",
                explanation: "The Benchmark makes its validation signal explicit.",
                answerExcerpt: "operational cost",
                benchmarkExcerpt: "measurable service outcomes",
              },
            ],
          })),
          findings: [],
        },
      },
      attempts: [{ ...attempt(), model: "synthetic/judge" }],
    };
  };
}

function providerFailure(model: string): ScriptedRoleRunStep {
  return {
    status: "failure",
    error: { code: "provider_timeout", message: "private provider detail" },
    attempts: [{ ...attempt(), model, outcome: "timeout" }],
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

  async function completeSingleHumanChain(
    checkpointSteps: ScriptedRoleRunStep[] = [],
  ): Promise<void> {
    await startFlow(checkpointSteps, 1);
    await engine.dispatch({
      type: "take_over",
      sessionId: "session-1",
      idempotencyKey: "take-over-1",
    });
    await engine.dispatch({
      type: "submit_human_answer",
      sessionId: "session-1",
      answer: "I owned the rollback decision and validated operational cost.",
      idempotencyKey: "human-1",
    });
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
    expect(persistedState.stateVersion).toBe(4);
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

  it("generates an immutable rubric-first Checkpoint for only the human turns", async () => {
    let humanTurnIds: string[] = [];
    await startFlow([
      candidateAnswer(),
      nextQuestion("Why was idempotent retry the right tradeoff?"),
      nextQuestion("Which signals would trigger rollback?"),
      turnEvaluation("operational cost", "evidence_and_outcome"),
      turnEvaluation("duplicate growth", "target_level_depth"),
      (request) => {
        const requestInput = JSON.parse(request.input) as {
          humanQuestions: Array<{ turnId: string; evidenceAnchorIds: string[] }>;
        };
        humanTurnIds = requestInput.humanQuestions.map((question) => question.turnId);
        const persisted = new Database(databasePath, { readonly: true });
        const row = persisted
          .prepare("select state_json from sessions where id = ?")
          .get("session-1") as { state_json: string };
        persisted.close();
        const state = JSON.parse(row.state_json) as {
          checkpoint: { status: string; evaluations: unknown[] };
        };
        expect(state.checkpoint).toMatchObject({ status: "benchmarking" });
        expect(state.checkpoint.evaluations).toHaveLength(2);
        return {
          status: "success" as const,
          value: {
            outcome: {
              benchmarks: [
                {
                  turnId: humanTurnIds[0],
                  text: "I would compare duplicate risk, recovery time, and measurable validation signals.",
                  evidenceAnchorIds: requestInput.humanQuestions[0].evidenceAnchorIds,
                },
                {
                  turnId: humanTurnIds[1],
                  text: "I would roll back on sustained duplicate growth or latency regression thresholds.",
                  evidenceAnchorIds: requestInput.humanQuestions[1].evidenceAnchorIds,
                },
              ],
            },
          },
          attempts: [{ ...attempt(), model: "synthetic/candidate" }],
        };
      },
      (request) => {
        const requestInput = JSON.parse(request.input) as {
          humanTurns: Array<{ turnId: string }>;
        };
        return {
          status: "success" as const,
          value: {
            outcome: {
            comparisons: [
              {
                turnId: requestInput.humanTurns[0].turnId,
                differences: [
                  {
                    dimension: "evidence_and_outcome",
                    explanation: "The answer does not name measurable validation signals.",
                    answerExcerpt: "operational cost",
                    benchmarkExcerpt: "measurable validation signals",
                  },
                ],
              },
              {
                turnId: requestInput.humanTurns[1].turnId,
                differences: [
                  {
                    dimension: "target_level_depth",
                    explanation: "The answer does not define sustained thresholds.",
                    answerExcerpt: "duplicate growth",
                    benchmarkExcerpt: "latency regression thresholds",
                  },
                ],
              },
            ],
            findings: [
              {
                targetDimension: "evidence_and_outcome",
                summary: "Connect decisions to measurable validation.",
                basis: "The tradeoff answer omits concrete validation signals.",
                sourceTurnIds: [requestInput.humanTurns[0].turnId],
              },
              {
                targetDimension: "target_level_depth",
                summary: "Define operational thresholds.",
                basis: "The rollback answer names direction but not sustained thresholds.",
                sourceTurnIds: [requestInput.humanTurns[1].turnId],
              },
            ],
            },
          },
          attempts: [{ ...attempt(), model: "synthetic/judge" }],
        };
      },
    ]);

    await engine.dispatch({
      type: "request_ai_answer",
      sessionId: "session-1",
      idempotencyKey: "candidate-1",
    });
    await engine.dispatch({
      type: "request_next_question",
      sessionId: "session-1",
      idempotencyKey: "question-2",
    });
    await engine.dispatch({
      type: "take_over",
      sessionId: "session-1",
      idempotencyKey: "take-over-1",
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
    await engine.dispatch({
      type: "submit_human_answer",
      sessionId: "session-1",
      answer: "I would roll back on sustained duplicate growth or latency regression.",
      idempotencyKey: "human-3",
    });

    const generated = await engine.dispatch({
      type: "generate_checkpoint",
      sessionId: "session-1",
      idempotencyKey: "checkpoint-1",
    });
    expect(generated).toMatchObject({
      status: "applied",
      session: {
        state: {
          checkpoint: {
            status: "completed",
            evaluations: [{ turnId: expect.any(String) }, { turnId: expect.any(String) }],
            benchmarkBatch: {
              benchmarks: [{ turnId: expect.any(String) }, { turnId: expect.any(String) }],
            },
            findings: [
              { priority: 1, calibration: "unreviewed" },
              { priority: 2, calibration: "unreviewed" },
            ],
          },
        },
      },
    });
    if (generated.status !== "applied") throw new Error("Checkpoint was not generated");
    expect(generated.session.state.checkpoint?.evaluations.map((item) => item.turnId)).toEqual(
      humanTurnIds,
    );
    expect(JSON.stringify(generated.session.state)).not.toContain("judge-turn-evaluation-v1");
    expect(JSON.stringify(generated.session.state)).not.toContain("candidate-benchmark-v1");
    expect(JSON.stringify(generated.session.state)).not.toContain("judge-checkpoint-v1");
    expect(engine.timeline("session-1").map((event) => event.type).slice(-5)).toEqual([
      "operation_started",
      "turn_evaluation_recorded",
      "turn_evaluation_recorded",
      "benchmarks_generated",
      "checkpoint_generated",
    ]);

    const persistedCheckpoint = generated.session.state.checkpoint;
    reopen([]);
    expect(engine.get("session-1").state.checkpoint).toEqual(persistedCheckpoint);

    const replay = await engine.dispatch({
      type: "generate_checkpoint",
      sessionId: "session-1",
      idempotencyKey: "checkpoint-1",
    });
    expect(replay).toEqual(generated);
    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-2",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "generate_checkpoint_not_available",
        details: { reason: "checkpoint_already_generated" },
      },
    });
  });

  it("returns stable Checkpoint availability reasons", async () => {
    await createSession();
    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-draft",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "generate_checkpoint_not_available",
        details: { reason: "session_not_active" },
      },
    });

    reopen([readyPlan(), firstQuestion()]);
    await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });
    await engine.dispatch({
      type: "start",
      sessionId: "session-1",
      idempotencyKey: "start-1",
    });
    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-active",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "generate_checkpoint_not_available",
        details: { reason: "attack_chain_not_completed" },
      },
    });
  });

  it("does not offer an observational Checkpoint for a pure A2A chain", async () => {
    await startFlow([candidateAnswer()], 1);
    await engine.dispatch({
      type: "request_ai_answer",
      sessionId: "session-1",
      idempotencyKey: "candidate-1",
    });

    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-a2a",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "generate_checkpoint_not_available",
        details: { reason: "no_human_answers" },
      },
    });
  });

  it.each([
    {
      stage: "evaluating" as const,
      steps: [providerFailure("synthetic/judge")],
      progressEvents: [] as string[],
    },
    {
      stage: "benchmarking" as const,
      steps: [
        turnEvaluation("operational cost", "evidence_and_outcome"),
        providerFailure("synthetic/candidate"),
      ],
      progressEvents: ["turn_evaluation_recorded"],
    },
    {
      stage: "synthesizing" as const,
      steps: [
        turnEvaluation("operational cost", "evidence_and_outcome"),
        benchmarkBatch(),
        providerFailure("synthetic/judge"),
      ],
      progressEvents: ["turn_evaluation_recorded", "benchmarks_generated"],
    },
  ])(
    "preserves hidden partial artifacts when the $stage Checkpoint stage fails",
    async ({ stage, steps, progressEvents }) => {
      await completeSingleHumanChain(steps);
      const failed = await engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-failure",
      });
      expect(failed).toMatchObject({
        status: "rejected",
        error: { code: "provider_timeout", details: { stage } },
      });
      expect(engine.get("session-1")).toMatchObject({
        status: "error",
        state: {
          checkpoint: null,
          failedOperation: { type: "generate_checkpoint", stage },
        },
      });

      const database = new Database(databasePath, { readonly: true });
      const row = database
        .prepare("select state_json from sessions where id = ?")
        .get("session-1") as { state_json: string };
      database.close();
      const internalState = JSON.parse(row.state_json) as {
        checkpoint: { status: string; evaluations: unknown[]; benchmarkBatch: unknown };
      };
      expect(internalState.checkpoint.status).toBe(stage);
      expect(internalState.checkpoint.evaluations).toHaveLength(
        stage === "evaluating" ? 0 : 1,
      );
      expect(internalState.checkpoint.benchmarkBatch === null).toBe(
        stage !== "synthesizing",
      );
      expect(
        engine.timeline("session-1").map((event) => event.type).slice(-(progressEvents.length + 1)),
      ).toEqual([...progressEvents, "operation_failed"]);
      expect(engine.timeline("session-1").at(-1)).toMatchObject({
        type: "operation_failed",
        payload: { operation: "generate_checkpoint", stage },
      });

      await expect(
        engine.dispatch({
          type: "generate_checkpoint",
          sessionId: "session-1",
          idempotencyKey: "checkpoint-failure",
        }),
      ).resolves.toEqual(failed);
      await expect(
        engine.dispatch({
          type: "generate_checkpoint",
          sessionId: "session-1",
          idempotencyKey: "checkpoint-bypass",
        }),
      ).resolves.toMatchObject({
        status: "rejected",
        error: {
          code: "generate_checkpoint_not_available",
          details: { reason: "session_in_error" },
        },
      });
    },
  );

  it("stops after three semantically invalid Judge evaluations", async () => {
    const invalidEvaluation = {
      status: "success" as const,
      value: {
        outcome: {
          dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
            dimension,
            verdict: dimension === "evidence_and_outcome" ? "partial" as const : "met" as const,
            rationale: "The answer leaves one dimension incomplete.",
            answerExcerpts: ["text absent from the human answer"],
          })),
        },
      },
      attempts: [{ ...attempt(), model: "synthetic/judge" }],
    };
    await completeSingleHumanChain([
      invalidEvaluation,
      invalidEvaluation,
      invalidEvaluation,
    ]);

    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-semantic-exhaustion",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "semantic_candidates_exhausted",
        details: {
          stage: "evaluating",
          rejectionCounts: { evaluation_excerpt_not_found: 3 },
          lastRejectionReason: "evaluation_excerpt_not_found",
        },
      },
    });
    expect(engine.timeline("session-1").at(-1)).toMatchObject({
      type: "operation_failed",
      payload: {
        stage: "evaluating",
        usage: { requests: 3 },
        rejectionCounts: { evaluation_excerpt_not_found: 3 },
      },
    });
  });

  it("does not consume a Checkpoint key during concurrent generation", async () => {
    let enteredResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    await completeSingleHumanChain([
      async () => {
        enteredResolve();
        await release;
        return {
          status: "success",
          value: {
            outcome: {
              dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
                dimension,
                verdict: dimension === "evidence_and_outcome" ? "partial" : "met",
                rationale: "The answer leaves one dimension incomplete.",
                answerExcerpts: ["operational cost"],
              })),
            },
          },
          attempts: [{ ...attempt(), model: "synthetic/judge" }],
        };
      },
      benchmarkBatch(),
      checkpointReportWithNoFindings(),
    ]);

    const pending = engine.dispatch({
      type: "generate_checkpoint",
      sessionId: "session-1",
      idempotencyKey: "checkpoint-winner",
    });
    await entered;
    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-loser",
      }),
    ).resolves.toMatchObject({ status: "rejected", error: { code: "session_busy" } });
    releaseResolve();
    await expect(pending).resolves.toMatchObject({ status: "applied" });
    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-loser",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "generate_checkpoint_not_available",
        details: { reason: "checkpoint_already_generated" },
      },
    });
  });

  it("recovers an interrupted Checkpoint with persisted evaluations still hidden", async () => {
    let enteredResolve: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    await completeSingleHumanChain([
      turnEvaluation("operational cost", "evidence_and_outcome"),
      async (request) => {
        enteredResolve();
        await release;
        const input = JSON.parse(request.input) as {
          humanQuestions: Array<{ turnId: string; evidenceAnchorIds: string[] }>;
        };
        return {
          status: "success",
          value: {
            outcome: {
              benchmarks: input.humanQuestions.map((question) => ({
                turnId: question.turnId,
                text: "I would validate measurable service outcomes.",
                evidenceAnchorIds: [question.evidenceAnchorIds[0]],
              })),
            },
          },
          attempts: [{ ...attempt(), model: "synthetic/candidate" }],
        };
      },
    ]);
    const interruptedEngine = engine;
    const pending = interruptedEngine.dispatch({
      type: "generate_checkpoint",
      sessionId: "session-1",
      idempotencyKey: "checkpoint-interrupted",
    });
    await entered;

    engine = createEngine([]);
    expect(engine.get("session-1")).toMatchObject({
      status: "error",
      state: {
        checkpoint: null,
        failedOperation: {
          type: "generate_checkpoint",
          code: "operation_interrupted",
          stage: "benchmarking",
        },
      },
    });
    expect(engine.timeline("session-1").slice(-2)).toMatchObject([
      { type: "turn_evaluation_recorded" },
      { type: "operation_failed", payload: { stage: "benchmarking" } },
    ]);
    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-interrupted",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "operation_interrupted",
        details: { stage: "benchmarking" },
      },
    });
    await expect(
      engine.dispatch({
        type: "generate_checkpoint",
        sessionId: "session-1",
        idempotencyKey: "checkpoint-after-interrupt",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      error: {
        code: "generate_checkpoint_not_available",
        details: { reason: "session_in_error" },
      },
    });

    releaseResolve();
    await expect(pending).resolves.toMatchObject({
      status: "rejected",
      error: { code: "operation_conflict" },
    });
    interruptedEngine.close();
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
  async function learningFlow(extra: ScriptedRoleRunStep[] = []) {
    const report = checkpointReportWithNoFindings();
    if (typeof report !== "function") throw new Error("Expected fixture function");
    await completeSingleHumanChain([
      turnEvaluation("operational cost", "evidence_and_outcome"), benchmarkBatch(),
      async request => {
        const result = await report(request);
        if (result.status !== "success") throw new Error("Expected fixture success");
        const value = result.value as { outcome: { findings: unknown[] } };
        const input = JSON.parse(request.input);
        value.outcome.findings = [{ targetDimension: "evidence_and_outcome", summary: "Validate outcomes",
          basis: "Metrics were missing", sourceTurnIds: [input.humanTurns[0].turnId] }];
        return result;
      },
      ...extra,
    ]);
    expect(await engine.dispatch({ type: "generate_checkpoint", sessionId: "session-1", idempotencyKey: "checkpoint" })).toMatchObject({ status: "applied" });
    return engine.get("session-1").state.checkpoint!.findings[0].id;
  }

  const preparationStep: ScriptedRoleRunStep = { status: "success", value: { outcome: {
    targetDimension: "evidence_and_outcome", microExplanation: "Connect decisions to measurable results.",
    question: "In a new payment service rollout, how would you validate its outcome?",
    scenarioChange: "Transfer from queue migration to a hypothetical payment rollout.",
  } } };
  const evaluationStep = (covered: boolean): ScriptedRoleRunStep => ({ status: "success", value: { outcome: {
    covered, explanation: covered ? "The answer names a measurable comparison." : "No measured comparison.",
    answerExcerpts: covered ? ["Compare failure rate"] : [],
  } } });

  it.each(["ProximalImprovement", "AssistedCorrection", "unresolved", "deferred"] as const)(
    "records %s without adding formal turns, preserves calibration and Reflection across restart", async outcome => {
      const steps: ScriptedRoleRunStep[] = [preparationStep];
      if (outcome !== "deferred") steps.push(evaluationStep(outcome === "ProximalImprovement"));
      if (outcome === "AssistedCorrection" || outcome === "unresolved") steps.push(
        { status: "success", value: { outcome: { hint: "Consider a before/after metric." } } },
        evaluationStep(outcome === "AssistedCorrection"),
      );
      const findingId = await learningFlow(steps);
      const calibration = { type: "calibrate_finding" as const, sessionId: "session-1", findingId,
        calibration: "partial" as const, idempotencyKey: "calibrate" };
      const calibrated = await engine.dispatch(calibration);
      expect(await engine.dispatch(calibration)).toEqual(calibrated);
      expect(await engine.dispatch({ ...calibration, idempotencyKey: "calibrate-again" })).toMatchObject({ status: "applied" });
      expect(engine.get("session-1").state.learning.gaps).toHaveLength(1);
      const beforeReflection = engine.get("session-1").state.checkpoint;
      expect(await engine.dispatch({ type: "add_reflection", sessionId: "session-1", idempotencyKey: "reflect",
        turnId: engine.get("session-1").state.execution!.turns[0].id, text: "I should quantify the outcome." })).toMatchObject({ status: "applied" });
      expect(engine.get("session-1").state.checkpoint).toEqual(beforeReflection);
      expect(await engine.dispatch({ type: "prepare_rechallenge", sessionId: "session-1", idempotencyKey: "prepare" })).toMatchObject({ status: "applied" });
      if (outcome === "deferred") {
        await engine.dispatch({ type: "skip_rechallenge", sessionId: "session-1", idempotencyKey: "skip" });
      } else {
        await engine.dispatch({ type: "submit_rechallenge_answer", sessionId: "session-1", idempotencyKey: "answer-r1", answer: "Compare failure rate before and after rollout." });
        await engine.dispatch({ type: "evaluate_rechallenge", sessionId: "session-1", idempotencyKey: "evaluate-r1" });
        if (outcome !== "ProximalImprovement") {
          expect(await engine.dispatch({ type: "generate_hint", sessionId: "session-1", idempotencyKey: "hint" })).toMatchObject({ status: "applied" });
          await engine.dispatch({ type: "submit_rechallenge_answer", sessionId: "session-1", idempotencyKey: "answer-r2", answer: "Compare failure rate before and after rollout." });
          await engine.dispatch({ type: "evaluate_rechallenge", sessionId: "session-1", idempotencyKey: "evaluate-r2" });
        }
      }
      expect(engine.get("session-1").state.learning.rechallenge?.outcome).toBe(outcome);
      expect(engine.get("session-1").state.execution!.turns).toHaveLength(1);
      const saved = engine.get("session-1");
      reopen([]);
      expect(engine.get("session-1")).toEqual(saved);
      expect(engine.timeline("session-1").filter(e => e.type === "reflection_added")).toHaveLength(1);
    },
  );

  it("honors inaccurate as final calibration without creating a gap or calling a model", async () => {
    const findingId = await learningFlow();
    const before = engine.get("session-1").usage.requests;
    await engine.dispatch({ type: "calibrate_finding", sessionId: "session-1", idempotencyKey: "reject-finding", findingId, calibration: "inaccurate" });
    expect(await engine.dispatch({ type: "prepare_rechallenge", sessionId: "session-1", idempotencyKey: "prepare" })).toMatchObject({ status: "rejected" });
    expect(await engine.dispatch({ type: "calibrate_finding", sessionId: "session-1", idempotencyKey: "change-calibration", findingId, calibration: "accurate" })).toMatchObject({ status: "rejected" });
    expect(engine.get("session-1").state.learning.gaps).toEqual([]);
    expect(engine.get("session-1").usage.requests).toBe(before);
  });

  it("resumes a failed Checkpoint from its frozen evaluations after restart", async () => {
    await completeSingleHumanChain([turnEvaluation("operational cost", "evidence_and_outcome"), providerFailure("synthetic/candidate")]);
    await engine.dispatch({ type: "generate_checkpoint", sessionId: "session-1", idempotencyKey: "checkpoint-failure" });
    const usage = engine.get("session-1").usage;
    reopen([benchmarkBatch(), checkpointReportWithNoFindings()]);
    expect(engine.get("session-1").usage).toEqual(usage);
    await engine.dispatch({ type: "resume_error", sessionId: "session-1", idempotencyKey: "resume" });
    expect(await engine.dispatch({ type: "generate_checkpoint", sessionId: "session-1", idempotencyKey: "checkpoint-retry" })).toMatchObject({ status: "applied" });
    expect(engine.timeline("session-1").filter(event => event.type === "turn_evaluation_recorded")).toHaveLength(1);
    expect(engine.get("session-1").usage.requests).toBe(usage.requests + 2);
  });

  it("pauses before request 61 including retries, extends once, and keeps usage on restart", async () => {
    await createSession();
    const database = new Database(databasePath);
    const insert = database.prepare("insert into model_requests (id, session_id, operation_token, input_tokens, output_tokens) values (?, 'session-1', 'prior', 1, 1)");
    for (let i = 0; i < 59; i++) insert.run(`prior-${i}`);
    database.close();
    reopen([{ ...readyPlan(), attempts: [attempt(1), attempt(2), attempt(3)] }]);
    expect(await engine.dispatch({ type: "generate_plan", sessionId: "session-1", idempotencyKey: "boundary" })).toMatchObject({ status: "rejected", error: { code: "budget_exhausted" } });
    expect(engine.get("session-1")).toMatchObject({ status: "budget_paused", usage: { requests: 60, limit: 60 } });
    expect(engine.timeline("session-1").at(-1)).toMatchObject({ type: "operation_failed", payload: { usage: { requests: 1 } } });
    expect(await engine.dispatch({ type: "resume_error", sessionId: "session-1", idempotencyKey: "cannot-resume" })).toMatchObject({ status: "rejected", error: { code: "budget_paused" } });
    const extend = { type: "extend_budget" as const, sessionId: "session-1", idempotencyKey: "extend" };
    const extended = await engine.dispatch(extend);
    expect(await engine.dispatch(extend)).toEqual(extended);
    reopen([readyPlan()]);
    expect(engine.get("session-1").usage).toMatchObject({ requests: 60, limit: 80 });
    await engine.dispatch({ type: "resume_error", sessionId: "session-1", idempotencyKey: "resume" });
    expect(await engine.dispatch({ type: "generate_plan", sessionId: "session-1", idempotencyKey: "retry" })).toMatchObject({ status: "applied", session: { usage: { requests: 61, limit: 80 } } });
    expect(engine.timeline("session-1").filter(e => e.type === "budget_extended")).toHaveLength(1);
  });

  it("upgrades Step 4 request history without resetting the saved Session", async () => {
    await learningFlow();
    const before = engine.get("session-1");
    engine.close();
    const database = new Database(databasePath);
    database.exec("drop table model_requests");
    database.exec("delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)");
    database.close();
    migrateDatabase(databasePath);
    engine = createEngine([]);
    expect(engine.get("session-1")).toEqual(before);
  });

});
