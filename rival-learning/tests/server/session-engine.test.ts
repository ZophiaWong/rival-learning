import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createPreparationProfiles,
  type PreparationProfiles,
} from "@/server/preparation-profiles";
import { ScriptedInterviewAgents } from "@/server/interview-agents/scripted";
import { migrateDatabase } from "@/server/persistence/migrate";
import { createSessionEngine, type SessionEngine } from "@/server/session-engine";

describe("SessionEngine.dispatch interface", () => {
  let directory: string;
  let databasePath: string;
  let profiles: PreparationProfiles;
  let engine: SessionEngine;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rival-learning-session-engine-"));
    databasePath = join(directory, "app.db");
    migrateDatabase(databasePath);
    let idSequence = 0;
    const createId = () => `id-${++idSequence}`;
    profiles = createPreparationProfiles({
      databasePath,
      createId,
      now: () => new Date("2026-08-27T08:00:00.000Z"),
    });
    engine = createSessionEngine({
      databasePath,
      preparationProfiles: profiles,
      interviewAgents: new ScriptedInterviewAgents([]),
      createOperationToken: createId,
      now: () => new Date("2026-08-27T08:00:00.000Z"),
    });
  });

  afterEach(() => {
    engine.close();
    profiles.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("creates a Session only from a confirmed ProviderView and locks its ProfileSnapshot", async () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Email: candidate@example.com\nBuilt the original queue consumer",
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
      idempotencyKey: "create-1",
    });
    const duplicate = await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      idempotencyKey: "create-1",
    });

    expect(created).toMatchObject({
      status: "applied",
      session: {
        id: "session-1",
        status: "draft",
        profileSnapshot: {
          profile: { resume: expect.stringContaining("original queue") },
          providerView: { resume: expect.not.stringContaining("candidate@example.com") },
          redactionVersion: "contact-v1",
        },
      },
      events: [{ sequence: 1, type: "session_created" }],
    });
    expect(duplicate).toEqual(created);

    profiles.update(profile.id, {
      ...profiles.get(profile.id),
      resume: "Built the revised queue consumer",
    });
    expect(engine.get("session-1").profileSnapshot.profile.resume).toContain(
      "original queue",
    );
  });

  it("generates a fake plan outside a SQLite transaction and starts deterministically", async () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Built a queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      idempotencyKey: "create-1",
    });

    let externalWriteSucceeded = false;
    engine.close();
    engine = createSessionEngine({
      databasePath,
      preparationProfiles: profiles,
      interviewAgents: new ScriptedInterviewAgents([
        async () => {
          const secondConnection = new Database(databasePath);
          secondConnection.pragma("busy_timeout = 0");
          secondConnection
            .prepare("update sessions set updated_at = updated_at where id = ?")
            .run("session-1");
          secondConnection.close();
          externalWriteSucceeded = true;
          return {
            status: "success",
            value: {
              objective: "Probe ownership depth",
              evidenceAnchor: "Built a queue consumer",
            },
            usage: { requests: 1, inputTokens: 120, outputTokens: 40 },
          };
        },
      ]),
      createOperationToken: () => "operation-1",
      now: () => new Date("2026-08-27T08:00:00.000Z"),
    });

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
        operationToken: null,
        state: {
          plan: {
            objective: "Probe ownership depth",
            evidenceAnchor: "Built a queue consumer",
          },
        },
      },
      events: [
        {
          sequence: 2,
          type: "plan_generated",
          payload: { usage: { requests: 1, inputTokens: 120, outputTokens: 40 } },
        },
      ],
    });
    expect(started).toMatchObject({
      status: "applied",
      session: { status: "active" },
      events: [{ sequence: 3, type: "session_started" }],
    });
  });

  it("rejects an illegal state command without timeline or state changes", async () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Built a queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      idempotencyKey: "create-1",
    });

    const before = engine.get("session-1");
    const result = await engine.dispatch({
      type: "start",
      sessionId: "session-1",
      idempotencyKey: "start-too-early",
    });

    expect(result).toMatchObject({
      status: "rejected",
      error: { code: "invalid_session_state" },
    });
    expect(engine.get("session-1")).toEqual(before);
    expect(engine.timeline("session-1").map((event) => event.type)).toEqual([
      "session_created",
    ]);
  });

  it("restores Profile and Session state after reopening database-backed modules", async () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Built a durable queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      idempotencyKey: "create-1",
    });

    engine.close();
    profiles.close();
    profiles = createPreparationProfiles({ databasePath });
    engine = createSessionEngine({
      databasePath,
      preparationProfiles: profiles,
      interviewAgents: new ScriptedInterviewAgents([]),
    });

    expect(profiles.get(profile.id)).toMatchObject({ name: "Backend preparation" });
    expect(profiles.previewProviderView(profile.id).confirmedAt).not.toBeNull();
    expect(engine.get("session-1")).toMatchObject({
      status: "draft",
      profileSnapshot: { profile: { resume: "Built a durable queue consumer" } },
    });
    expect(engine.timeline("session-1").map((event) => event.type)).toEqual([
      "session_created",
    ]);
  });

  it("reports retained history before deleting a Profile and preserves the Session snapshot", async () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Built a durable queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      idempotencyKey: "create-1",
    });

    expect(profiles.getDeletionImpact(profile.id)).toEqual({ retainedSessionCount: 1 });
    profiles.delete(profile.id);

    expect(engine.get("session-1")).toMatchObject({
      sourceProfileId: null,
      profileSnapshot: {
        profile: { name: "Backend preparation", resume: "Built a durable queue consumer" },
      },
    });
  });

  it("serializes concurrent commands and returns the committed result for duplicate idempotency keys", async () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Built a queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      idempotencyKey: "create-1",
    });

    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let releasePlan: () => void = () => undefined;
    const release = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });

    engine.close();
    engine = createSessionEngine({
      databasePath,
      preparationProfiles: profiles,
      interviewAgents: new ScriptedInterviewAgents([
        async () => {
          signalEntered();
          await release;
          return {
            status: "success",
            value: { objective: "Probe ownership", evidenceAnchor: "queue consumer" },
            usage: { requests: 1, inputTokens: 10, outputTokens: 5 },
          };
        },
      ]),
      createOperationToken: () => "operation-1",
      now: () => new Date("2026-08-27T08:00:00.000Z"),
    });

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
    releasePlan();
    const applied = await first;
    const duplicate = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });

    expect(concurrent).toMatchObject({ status: "rejected", error: { code: "session_busy" } });
    expect(applied).toMatchObject({ status: "applied", session: { status: "planned" } });
    expect(duplicate).toEqual(applied);
    expect(engine.timeline("session-1").map((event) => event.type)).toEqual([
      "session_created",
      "plan_generated",
    ]);
  });

  it("commits a scripted Agent failure as a recoverable error without a partial plan", async () => {
    const profile = profiles.create({
      name: "Backend preparation",
      resume: "Built a queue consumer",
      projectNotes: "",
      jobDescription: "Backend role",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      repoPath: null,
    });
    profiles.previewProviderView(profile.id);
    profiles.confirmProviderView(profile.id);
    await engine.dispatch({
      type: "create_session",
      sessionId: "session-1",
      profileId: profile.id,
      idempotencyKey: "create-1",
    });

    engine.close();
    engine = createSessionEngine({
      databasePath,
      preparationProfiles: profiles,
      interviewAgents: new ScriptedInterviewAgents([
        {
          status: "failure",
          code: "scripted_failure",
          message: "Synthetic plan failure",
          usage: { requests: 1, inputTokens: 20, outputTokens: 0 },
        },
      ]),
      createOperationToken: () => "operation-1",
      now: () => new Date("2026-08-27T08:00:00.000Z"),
    });

    const result = await engine.dispatch({
      type: "generate_plan",
      sessionId: "session-1",
      idempotencyKey: "plan-1",
    });

    expect(result).toEqual({
      status: "rejected",
      error: { code: "scripted_failure", message: "Synthetic plan failure" },
    });
    expect(engine.get("session-1")).toMatchObject({
      status: "error",
      operationToken: null,
      state: { plan: null },
    });
    expect(engine.timeline("session-1").at(-1)).toMatchObject({
      type: "plan_failed",
      payload: {
        code: "scripted_failure",
        usage: { requests: 1, inputTokens: 20, outputTokens: 0 },
      },
    });
  });
});
