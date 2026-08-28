import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import type { InterviewAgents } from "@/server/interview-agents";
import {
  ProfileNotFoundError,
  ProviderViewNotConfirmedError,
  type PreparationProfiles,
  type ProfileSnapshot,
} from "@/server/preparation-profiles";

export type SessionStatus = "draft" | "planning" | "planned" | "active" | "error";

export interface SessionView {
  id: string;
  sourceProfileId: string | null;
  profileSnapshot: ProfileSnapshot;
  status: SessionStatus;
  state: { plan: { objective: string; evidenceAnchor: string } | null };
  version: number;
  operationToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEvent {
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export type SessionCommand =
  | {
      type: "create_session";
      sessionId: string;
      profileId: string;
      idempotencyKey: string;
    }
  | { type: "generate_plan"; sessionId: string; idempotencyKey: string }
  | { type: "start"; sessionId: string; idempotencyKey: string };

export type SessionCommandError = {
  code: string;
  message: string;
};

export type DispatchResult =
  | { status: "applied"; session: SessionView; events: TimelineEvent[] }
  | { status: "rejected"; error: SessionCommandError };

function commandFingerprint(command: SessionCommand): string {
  const payload =
    command.type === "create_session"
      ? { type: command.type, sessionId: command.sessionId, profileId: command.profileId }
      : { type: command.type, sessionId: command.sessionId };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function idempotencyConflict(): DispatchResult {
  return {
    status: "rejected",
    error: {
      code: "idempotency_key_conflict",
      message: "Idempotency-Key was already used for a different SessionCommand",
    },
  };
}

export interface SessionEngine {
  dispatch(command: SessionCommand): Promise<DispatchResult>;
  get(sessionId: string): SessionView;
  list(): SessionView[];
  timeline(sessionId: string, afterSequence?: number): TimelineEvent[];
  close(): void;
}

export interface SessionEngineOptions {
  databasePath: string;
  preparationProfiles: PreparationProfiles;
  interviewAgents: InterviewAgents;
  createOperationToken?: () => string;
  now?: () => Date;
}

interface SessionRow {
  id: string;
  source_profile_id: string | null;
  profile_snapshot_json: string;
  status: SessionStatus;
  state_json: string;
  version: number;
  operation_token: string | null;
  created_at: number;
  updated_at: number;
}

function mapSession(row: SessionRow): SessionView {
  return {
    id: row.id,
    sourceProfileId: row.source_profile_id,
    profileSnapshot: JSON.parse(row.profile_snapshot_json) as ProfileSnapshot,
    status: row.status,
    state: JSON.parse(row.state_json) as SessionView["state"],
    version: row.version,
    operationToken: row.operation_token,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

class ApplicationSessionEngine implements SessionEngine {
  private readonly database: Database.Database;
  private readonly preparationProfiles: PreparationProfiles;
  private readonly interviewAgents: InterviewAgents;
  private readonly createOperationToken: () => string;
  private readonly now: () => Date;

  constructor(options: SessionEngineOptions) {
    this.database = new Database(options.databasePath);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.preparationProfiles = options.preparationProfiles;
    this.interviewAgents = options.interviewAgents;
    this.createOperationToken = options.createOperationToken ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async dispatch(command: SessionCommand): Promise<DispatchResult> {
    if (command.type === "create_session") {
      return this.createSession(command);
    }
    if (command.type === "generate_plan") {
      return this.generatePlan(command);
    }
    return this.startSession(command);
  }

  get(sessionId: string): SessionView {
    const row = this.database
      .prepare(
        `select id, source_profile_id, profile_snapshot_json, status, state_json, version,
                operation_token, created_at, updated_at
         from sessions where id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return mapSession(row);
  }

  list(): SessionView[] {
    const rows = this.database
      .prepare(
        `select id, source_profile_id, profile_snapshot_json, status, state_json, version,
                operation_token, created_at, updated_at
         from sessions order by created_at, id`,
      )
      .all() as SessionRow[];
    return rows.map(mapSession);
  }

  timeline(sessionId: string, afterSequence = 0): TimelineEvent[] {
    this.get(sessionId);
    const rows = this.database
      .prepare(
        `select sequence, event_type, payload_json, created_at
         from session_timeline where session_id = ? and sequence > ? order by sequence`,
      )
      .all(sessionId, afterSequence) as Array<{
      sequence: number;
      event_type: string;
      payload_json: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      type: row.event_type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  close(): void {
    this.database.close();
  }

  private createSession(command: Extract<SessionCommand, { type: "create_session" }>): DispatchResult {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    const existing = this.database.prepare("select 1 from sessions where id = ?").get(command.sessionId);
    if (existing) {
      return this.commitRejection(command, {
        status: "rejected",
        error: { code: "session_exists", message: `Session already exists: ${command.sessionId}` },
      });
    }

    let snapshot: Readonly<ProfileSnapshot>;
    try {
      snapshot = this.preparationProfiles.createSnapshot(command.profileId);
    } catch (error) {
      if (error instanceof ProviderViewNotConfirmedError || error instanceof ProfileNotFoundError) {
        return this.commitRejection(command, {
          status: "rejected",
          error: { code: error.code, message: error.message },
        });
      }
      throw error;
    }

    const timestamp = this.now();
    const state: SessionView["state"] = { plan: null };
    const event: TimelineEvent = {
      sequence: 1,
      type: "session_created",
      payload: {},
      createdAt: timestamp.toISOString(),
    };
    const result: DispatchResult = {
      status: "applied",
      session: {
        id: command.sessionId,
        sourceProfileId: command.profileId,
        profileSnapshot: snapshot,
        status: "draft",
        state,
        version: 1,
        operationToken: null,
        createdAt: timestamp.toISOString(),
        updatedAt: timestamp.toISOString(),
      },
      events: [event],
    };

    this.database.transaction(() => {
      this.database
        .prepare(
          `insert into sessions
            (id, source_profile_id, profile_snapshot_json, provider_view_json, redaction_version,
             status, state_json, version, operation_token, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          command.sessionId,
          command.profileId,
          JSON.stringify(snapshot),
          JSON.stringify(snapshot.providerView),
          snapshot.redactionVersion,
          "draft",
          JSON.stringify(state),
          1,
          null,
          timestamp.getTime(),
          timestamp.getTime(),
        );
      this.database
        .prepare(
          `insert into session_timeline
            (session_id, sequence, event_type, payload_json, created_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run(command.sessionId, 1, "session_created", "{}", timestamp.getTime());
      this.insertIdempotency(command, timestamp, result);
    })();

    return result;
  }

  private async generatePlan(
    command: Extract<SessionCommand, { type: "generate_plan" }>,
  ): Promise<DispatchResult> {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    let session: SessionView;
    try {
      session = this.get(command.sessionId);
    } catch {
      return this.commitRejection(command, {
        status: "rejected",
        error: { code: "session_not_found", message: `Session not found: ${command.sessionId}` },
      });
    }

    if (session.operationToken !== null) {
      return {
        status: "rejected",
        error: {
          code: "session_busy",
          message: `Cannot generate plan while Session is ${session.status}`,
        },
      };
    }
    if (session.status !== "draft") {
      return this.commitRejection(command, {
        status: "rejected",
        error: {
          code: "invalid_session_state",
          message: `Cannot generate plan while Session is ${session.status}`,
        },
      });
    }

    const operationToken = this.createOperationToken();
    const reservedAt = this.now();
    const reservation = this.database
      .prepare(
        `update sessions
         set status = 'planning', operation_token = ?, version = version + 1, updated_at = ?
         where id = ? and status = 'draft' and operation_token is null`,
      )
      .run(operationToken, reservedAt.getTime(), command.sessionId);
    if (reservation.changes !== 1) {
      return {
        status: "rejected",
        error: { code: "session_busy", message: "Another Session operation is active" },
      };
    }

    let operationResult;
    try {
      operationResult = await this.interviewAgents.generatePlan({
        operationToken,
        profileSnapshot: session.profileSnapshot,
      });
    } catch (error) {
      operationResult = {
        status: "failure" as const,
        code: "agent_unexpected_error",
        message: error instanceof Error ? error.message : "Unknown InterviewAgents error",
        usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
      };
    }

    const completedAt = this.now();
    const sequence = this.nextSequence(command.sessionId);

    if (operationResult.status === "failure") {
      const result: DispatchResult = {
        status: "rejected",
        error: { code: operationResult.code, message: operationResult.message },
      };
      const event: TimelineEvent = {
        sequence,
        type: "plan_failed",
        payload: {
          code: operationResult.code,
          message: operationResult.message,
          usage: operationResult.usage,
        },
        createdAt: completedAt.toISOString(),
      };
      const committed = this.database.transaction(() => {
        const update = this.database
          .prepare(
            `update sessions
             set status = 'error', operation_token = null, version = version + 1, updated_at = ?
             where id = ? and status = 'planning' and operation_token = ?`,
          )
          .run(completedAt.getTime(), command.sessionId, operationToken);
        if (update.changes !== 1) {
          return false;
        }
        this.insertTimelineEvent(command.sessionId, event);
        this.insertIdempotency(command, completedAt, result);
        return true;
      })();

      if (!committed) {
        return {
          status: "rejected",
          error: { code: "operation_conflict", message: "Session changed before plan commit" },
        };
      }
      return result;
    }

    const event: TimelineEvent = {
      sequence,
      type: "plan_generated",
      payload: { usage: operationResult.usage },
      createdAt: completedAt.toISOString(),
    };
    const nextState: SessionView["state"] = { plan: operationResult.value };
    const result = this.database.transaction((): DispatchResult | null => {
      const update = this.database
        .prepare(
          `update sessions
           set status = 'planned', state_json = ?, operation_token = null,
               version = version + 1, updated_at = ?
           where id = ? and status = 'planning' and operation_token = ?`,
        )
        .run(
          JSON.stringify(nextState),
          completedAt.getTime(),
          command.sessionId,
          operationToken,
        );
      if (update.changes !== 1) {
        return null;
      }
      this.insertTimelineEvent(command.sessionId, event);
      const appliedResult: DispatchResult = {
        status: "applied",
        session: this.get(command.sessionId),
        events: [event],
      };
      this.insertIdempotency(command, completedAt, appliedResult);
      return appliedResult;
    })();

    if (!result) {
      return {
        status: "rejected",
        error: { code: "operation_conflict", message: "Session changed before plan commit" },
      };
    }
    return result;
  }

  private startSession(
    command: Extract<SessionCommand, { type: "start" }>,
  ): DispatchResult {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    let session: SessionView;
    try {
      session = this.get(command.sessionId);
    } catch {
      return this.commitRejection(command, {
        status: "rejected",
        error: { code: "session_not_found", message: `Session not found: ${command.sessionId}` },
      });
    }
    if (session.operationToken !== null) {
      return {
        status: "rejected",
        error: { code: "session_busy", message: `Cannot start Session from ${session.status}` },
      };
    }
    if (session.status !== "planned") {
      return this.commitRejection(command, {
        status: "rejected",
        error: { code: "invalid_session_state", message: `Cannot start Session from ${session.status}` },
      });
    }

    const timestamp = this.now();
    const event: TimelineEvent = {
      sequence: this.nextSequence(command.sessionId),
      type: "session_started",
      payload: {},
      createdAt: timestamp.toISOString(),
    };
    const result = this.database.transaction((): DispatchResult | null => {
      const update = this.database
        .prepare(
          `update sessions
           set status = 'active', version = version + 1, updated_at = ?
           where id = ? and status = 'planned' and operation_token is null`,
        )
        .run(timestamp.getTime(), command.sessionId);
      if (update.changes !== 1) {
        return null;
      }
      this.insertTimelineEvent(command.sessionId, event);
      const appliedResult: DispatchResult = {
        status: "applied",
        session: this.get(command.sessionId),
        events: [event],
      };
      this.insertIdempotency(command, timestamp, appliedResult);
      return appliedResult;
    })();
    if (!result) {
      return {
        status: "rejected",
        error: { code: "operation_conflict", message: "Session changed before start commit" },
      };
    }
    return result;
  }

  private findIdempotencyResult(command: SessionCommand): DispatchResult | null {
    const found = this.database
      .prepare(
        `select command_type, command_fingerprint, result_json
         from idempotency_results where session_id = ? and idempotency_key = ?`,
      )
      .get(command.sessionId, command.idempotencyKey) as
      | { command_type: string; command_fingerprint: string; result_json: string }
      | undefined;
    if (!found) {
      return null;
    }
    const fingerprintMatches = found.command_fingerprint
      ? found.command_fingerprint === commandFingerprint(command)
      : found.command_type === command.type;
    return fingerprintMatches
      ? (JSON.parse(found.result_json) as DispatchResult)
      : idempotencyConflict();
  }

  private commitRejection(
    command: SessionCommand,
    result: Extract<DispatchResult, { status: "rejected" }>,
  ): DispatchResult {
    this.insertIdempotency(command, this.now(), result);
    return result;
  }

  private nextSequence(sessionId: string): number {
    const row = this.database
      .prepare("select coalesce(max(sequence), 0) + 1 as sequence from session_timeline where session_id = ?")
      .get(sessionId) as { sequence: number };
    return row.sequence;
  }

  private insertTimelineEvent(sessionId: string, event: TimelineEvent): void {
    this.database
      .prepare(
        `insert into session_timeline
          (session_id, sequence, event_type, payload_json, created_at)
         values (?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        event.sequence,
        event.type,
        JSON.stringify(event.payload),
        Date.parse(event.createdAt),
      );
  }

  private insertIdempotency(
    command: SessionCommand,
    timestamp: Date,
    result: DispatchResult,
  ): void {
    this.database
      .prepare(
        `insert into idempotency_results
          (session_id, idempotency_key, command_type, command_fingerprint, result_json, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.sessionId,
        command.idempotencyKey,
        command.type,
        commandFingerprint(command),
        JSON.stringify(result),
        timestamp.getTime(),
      );
  }
}

export function createSessionEngine(options: SessionEngineOptions): SessionEngine {
  return new ApplicationSessionEngine(options);
}
