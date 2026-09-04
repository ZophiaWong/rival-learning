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

function readyPlan(anchor = { source: "resume", startLine: 1, endLine: 1 }) {
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
        estimatedDepth: 3,
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
});
