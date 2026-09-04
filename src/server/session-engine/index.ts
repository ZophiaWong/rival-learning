import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import {
  acceptNextQuestionCandidate,
  createAttackChainExecutionState,
  type QuestionSemanticRejectionReason,
} from "@/server/core-loop/attack-chain-execution";
import {
  generationMetadataSchema,
  type GenerationMetadata,
  type GenerationUsage,
  type InterviewLanguage,
  type ReadyAttackChain,
} from "@/server/core-loop/domain";
import {
  materializeInterviewPlanCandidate,
  measurePlanningInput,
  type PlanSemanticRejectionReason,
  type PlanningInputSizes,
} from "@/server/core-loop/grounding";
import {
  CORE_LOOP_V1_POLICY,
  createCoreLoopPolicySnapshot,
} from "@/server/core-loop/policy";
import type { InterviewAgents } from "@/server/interview-agents";
import {
  ProfileNotFoundError,
  ProviderViewNotConfirmedError,
  type PreparationProfiles,
  type ProfileSnapshot,
} from "@/server/preparation-profiles";
import {
  projectSessionState,
  sessionStateV2Schema,
  type PublicSessionState,
  type SessionOperation,
  type SessionPhase,
  type SessionStateV2,
} from "./state";
import {
  parseTimelineEvent,
  type TimelineEvent,
} from "./timeline";

export type { TimelineEvent } from "./timeline";
export type { PublicSessionState } from "./state";

export type SessionStatus = SessionPhase;

export interface SessionView {
  id: string;
  sourceProfileId: string | null;
  profileSnapshot: ProfileSnapshot;
  status: SessionStatus;
  state: PublicSessionState;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type SessionCommand =
  | {
      type: "create_session";
      sessionId: string;
      profileId: string;
      interviewLanguage: InterviewLanguage;
      idempotencyKey: string;
    }
  | { type: "generate_plan"; sessionId: string; idempotencyKey: string }
  | { type: "start"; sessionId: string; idempotencyKey: string };

export interface SessionCommandError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: {
    fieldSizes?: PlanningInputSizes;
    rejectionCounts?: Record<string, number>;
    lastRejectionReason?: string | null;
  };
}

export type DispatchResult =
  | { status: "applied"; session: SessionView; events: TimelineEvent[] }
  | { status: "rejected"; error: SessionCommandError };

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
  createEntityId?: () => string;
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

interface InternalSession {
  row: SessionRow;
  profileSnapshot: ProfileSnapshot;
  state: SessionStateV2;
}

interface ReservedOperation {
  operationToken: string;
  state: SessionStateV2;
  event: TimelineEvent;
}

const EMPTY_USAGE: GenerationUsage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  usageComplete: true,
};

function commandFingerprint(command: SessionCommand): string {
  const payload =
    command.type === "create_session"
      ? {
          type: command.type,
          sessionId: command.sessionId,
          profileId: command.profileId,
          interviewLanguage: command.interviewLanguage,
        }
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

function emptyGeneration(
  contractVersion: GenerationMetadata["contractVersion"],
): GenerationMetadata {
  return generationMetadataSchema.parse({
    contractVersion,
    provider: null,
    model: null,
    usage: EMPTY_USAGE,
  });
}

function mergeGeneration(
  current: GenerationMetadata,
  next: GenerationMetadata,
): GenerationMetadata {
  return generationMetadataSchema.parse({
    contractVersion: current.contractVersion,
    provider: next.provider ?? current.provider,
    model: next.model ?? current.model,
    usage: {
      requests: current.usage.requests + next.usage.requests,
      inputTokens: current.usage.inputTokens + next.usage.inputTokens,
      outputTokens: current.usage.outputTokens + next.usage.outputTokens,
      usageComplete: current.usage.usageComplete && next.usage.usageComplete,
    },
  });
}

function incrementCount(counts: Record<string, number>, reason: string): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function localizedFailureMessage(
  language: InterviewLanguage,
  operation: SessionOperation,
  code: string,
): string {
  if (language === "zh-CN") {
    if (code === "input_too_large") return "准备资料超过本版本可处理的长度，请缩短后创建新 Session。";
    if (code === "semantic_candidates_exhausted") {
      return operation === "generate_plan"
        ? "模型未能生成可验证的面试计划，请重试或补充更具体的资料。"
        : "模型未能生成有效且不重复的问题，请重试。";
    }
    if (code === "operation_interrupted") return "上一次模型操作被中断，可以安全重试。";
    return operation === "generate_plan"
      ? "面试计划生成失败，请检查模型配置后重试。"
      : "首个问题生成失败，请检查模型配置后重试。";
  }
  if (code === "input_too_large") {
    return "The preparation material exceeds this version's limit. Shorten it and create a new Session.";
  }
  if (code === "semantic_candidates_exhausted") {
    return operation === "generate_plan"
      ? "The model did not produce a verifiable interview plan. Retry or add more concrete evidence."
      : "The model did not produce a valid, non-duplicate question. Please retry.";
  }
  if (code === "operation_interrupted") {
    return "The previous model operation was interrupted and can be retried safely.";
  }
  return operation === "generate_plan"
    ? "Interview plan generation failed. Check the model configuration and retry."
    : "First-question generation failed. Check the model configuration and retry.";
}

function mapSession(session: InternalSession): SessionView {
  return {
    id: session.row.id,
    sourceProfileId: session.row.source_profile_id,
    profileSnapshot: session.profileSnapshot,
    status: session.state.phase,
    state: projectSessionState(session.state),
    version: session.row.version,
    createdAt: new Date(session.row.created_at).toISOString(),
    updatedAt: new Date(session.row.updated_at).toISOString(),
  };
}

class ApplicationSessionEngine implements SessionEngine {
  private readonly database: Database.Database;
  private readonly preparationProfiles: PreparationProfiles;
  private readonly interviewAgents: InterviewAgents;
  private readonly createOperationToken: () => string;
  private readonly createEntityId: () => string;
  private readonly now: () => Date;

  constructor(options: SessionEngineOptions) {
    this.database = new Database(options.databasePath);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.preparationProfiles = options.preparationProfiles;
    this.interviewAgents = options.interviewAgents;
    this.createOperationToken = options.createOperationToken ?? randomUUID;
    this.createEntityId = options.createEntityId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.recoverInterruptedOperations();
  }

  async dispatch(command: SessionCommand): Promise<DispatchResult> {
    if (command.type === "create_session") return this.createSession(command);
    if (command.type === "generate_plan") return this.generatePlan(command);
    return this.startSession(command);
  }

  get(sessionId: string): SessionView {
    return mapSession(this.getInternal(sessionId));
  }

  list(): SessionView[] {
    const rows = this.database
      .prepare(
        `select id, source_profile_id, profile_snapshot_json, status, state_json, version,
                operation_token, created_at, updated_at
         from sessions order by created_at, id`,
      )
      .all() as SessionRow[];
    return rows.map((row) => mapSession(this.parseInternal(row)));
  }

  timeline(sessionId: string, afterSequence = 0): TimelineEvent[] {
    this.getInternal(sessionId);
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
    return rows.map((row) =>
      parseTimelineEvent({
        sequence: row.sequence,
        type: row.event_type,
        payload: JSON.parse(row.payload_json) as unknown,
        createdAt: new Date(row.created_at).toISOString(),
      }),
    );
  }

  close(): void {
    this.database.close();
  }

  private getInternal(sessionId: string): InternalSession {
    const row = this.database
      .prepare(
        `select id, source_profile_id, profile_snapshot_json, status, state_json, version,
                operation_token, created_at, updated_at
         from sessions where id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    return this.parseInternal(row);
  }

  private parseInternal(row: SessionRow): InternalSession {
    return {
      row,
      profileSnapshot: JSON.parse(row.profile_snapshot_json) as ProfileSnapshot,
      state: sessionStateV2Schema.parse(JSON.parse(row.state_json) as unknown),
    };
  }

  private createSession(
    command: Extract<SessionCommand, { type: "create_session" }>,
  ): DispatchResult {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) return idempotencyResult;

    if (this.database.prepare("select 1 from sessions where id = ?").get(command.sessionId)) {
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
    const state = sessionStateV2Schema.parse({
      stateVersion: 2,
      phase: "draft",
      interviewLanguage: command.interviewLanguage,
      policy: createCoreLoopPolicySnapshot(),
      planRecord: null,
      execution: null,
      activeOperation: null,
      failedOperation: null,
    });
    const event = parseTimelineEvent({
      sequence: 1,
      type: "session_created",
      payload: { interviewLanguage: command.interviewLanguage },
      createdAt: timestamp.toISOString(),
    });

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
          state.phase,
          JSON.stringify(state),
          1,
          null,
          timestamp.getTime(),
          timestamp.getTime(),
        );
      this.insertTimelineEvent(command.sessionId, event);
      const result: DispatchResult = {
        status: "applied",
        session: this.get(command.sessionId),
        events: [event],
      };
      this.insertIdempotency(command, timestamp, result);
    })();

    return this.findIdempotencyResult(command)!;
  }

  private async generatePlan(
    command: Extract<SessionCommand, { type: "generate_plan" }>,
  ): Promise<DispatchResult> {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) return idempotencyResult;
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token || session.state.activeOperation) return this.sessionBusy("generate plan");
    if (session.state.phase !== "draft") {
      return this.commitRejection(command, this.invalidState("generate plan", session.state.phase));
    }

    const reserved = this.reserveOperation(command.sessionId, session, "generate_plan");
    if (!reserved) return this.sessionBusy("generate plan");

    const sizes = measurePlanningInput(session.profileSnapshot.providerView);
    if (sizes.total > reserved.state.policy.maxPlanningInputChars) {
      return this.commitOperationFailure({
        command,
        reserved,
        code: "input_too_large",
        retryable: false,
        generation: emptyGeneration(reserved.state.policy.plannerContractVersion),
        rejectionCounts: {},
        lastRejectionReason: null,
        details: { fieldSizes: sizes },
      });
    }

    let generation = emptyGeneration(reserved.state.policy.plannerContractVersion);
    const rejectionCounts: Record<string, number> = {};
    const semanticRejections: string[] = [];
    let lastReason: PlanSemanticRejectionReason | null = null;
    for (
      let candidateNumber = 1;
      candidateNumber <= reserved.state.policy.maxSemanticCandidatesPerOperation;
      candidateNumber += 1
    ) {
      const candidate = await this.safePlanCandidate({
        operationToken: reserved.operationToken,
        interviewLanguage: reserved.state.interviewLanguage,
        providerView: session.profileSnapshot.providerView,
        semanticRejections,
      });
      generation = mergeGeneration(generation, candidate.generation);
      if (candidate.status === "failure") {
        return this.commitOperationFailure({
          command,
          reserved,
          code: candidate.code,
          retryable: candidate.retryable,
          generation,
          rejectionCounts,
          lastRejectionReason: lastReason,
        });
      }
      const materialized = materializeInterviewPlanCandidate({
        candidate: candidate.value,
        providerView: session.profileSnapshot.providerView,
        generation,
        policy: reserved.state.policy,
        createId: this.createEntityId,
        createdAt: this.now().toISOString(),
      });
      if (materialized.status === "rejected") {
        lastReason = materialized.reason;
        incrementCount(rejectionCounts, materialized.reason);
        semanticRejections.push(materialized.reason);
        continue;
      }
      return this.commitPlan(command, reserved, materialized.record);
    }

    return this.commitOperationFailure({
      command,
      reserved,
      code: "semantic_candidates_exhausted",
      retryable: true,
      generation,
      rejectionCounts,
      lastRejectionReason: lastReason,
      details: { rejectionCounts, lastRejectionReason: lastReason },
    });
  }

  private async startSession(
    command: Extract<SessionCommand, { type: "start" }>,
  ): Promise<DispatchResult> {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) return idempotencyResult;
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token || session.state.activeOperation) return this.sessionBusy("start Session");
    if (session.state.phase !== "planned" || !session.state.planRecord) {
      return this.commitRejection(command, this.invalidState("start Session", session.state.phase));
    }
    const chain = session.state.planRecord.plan.attackChains[0];
    if (chain.status === "needs_input") {
      return this.commitRejection(command, {
        status: "rejected",
        error: {
          code: "attack_chain_needs_input",
          message: "Cannot start a Session until the AttackChain has grounded evidence",
        },
      });
    }
    if (!session.state.planRecord.questionContext) {
      return this.commitRejection(command, this.invalidState("start Session", session.state.phase));
    }

    const reserved = this.reserveOperation(command.sessionId, session, "start");
    if (!reserved) return this.sessionBusy("start Session");
    const initialExecution = createAttackChainExecutionState(chain.id);
    let generation = emptyGeneration(reserved.state.policy.questionContractVersion);
    const rejectionCounts: Record<string, number> = {};
    const semanticRejections: string[] = [];
    let lastReason: QuestionSemanticRejectionReason | null = null;

    for (
      let candidateNumber = 1;
      candidateNumber <= reserved.state.policy.maxSemanticCandidatesPerOperation;
      candidateNumber += 1
    ) {
      const candidate = await this.safeQuestionCandidate({
        operationToken: reserved.operationToken,
        interviewLanguage: reserved.state.interviewLanguage,
        plan: session.state.planRecord.plan,
        questionContext: session.state.planRecord.questionContext,
        jobDescription: session.profileSnapshot.providerView.jobDescription,
        targetRole: session.profileSnapshot.providerView.targetRole,
        targetLevel: session.profileSnapshot.providerView.targetLevel,
        publicTranscript: initialExecution.turns.map((turn) => ({
          question: turn.question.text,
          answer: turn.answer,
        })),
        currentDifficulty: initialExecution.turns.at(-1)?.question.difficulty ?? null,
        remainingDepth: chain.estimatedDepth - initialExecution.turns.length,
        semanticRejections,
      });
      generation = mergeGeneration(generation, candidate.generation);
      if (candidate.status === "failure") {
        return this.commitOperationFailure({
          command,
          reserved,
          code: candidate.code,
          retryable: candidate.retryable,
          generation,
          rejectionCounts,
          lastRejectionReason: lastReason,
        });
      }
      const transition = acceptNextQuestionCandidate({
        state: initialExecution,
        chain,
        candidate: candidate.value,
        generation,
        policy: reserved.state.policy,
        questionTurnId: this.createEntityId(),
        now: this.now().toISOString(),
      });
      if (transition.status === "rejected") {
        lastReason = transition.reason;
        incrementCount(rejectionCounts, transition.reason);
        semanticRejections.push(transition.reason);
        continue;
      }
      return this.commitSessionStart(command, reserved, chain, transition.state, generation);
    }

    return this.commitOperationFailure({
      command,
      reserved,
      code: "semantic_candidates_exhausted",
      retryable: true,
      generation,
      rejectionCounts,
      lastRejectionReason: lastReason,
      details: { rejectionCounts, lastRejectionReason: lastReason },
    });
  }

  private async safePlanCandidate(
    input: Parameters<InterviewAgents["planSingleAttackChain"]>[0],
  ): ReturnType<InterviewAgents["planSingleAttackChain"]> {
    try {
      return await this.interviewAgents.planSingleAttackChain(input);
    } catch {
      return {
        status: "failure",
        code: "agent_unexpected_error",
        message: "Unexpected InterviewAgents failure",
        retryable: false,
        generation: emptyGeneration(CORE_LOOP_V1_POLICY.plannerContractVersion),
      };
    }
  }

  private async safeQuestionCandidate(
    input: Parameters<InterviewAgents["generateNextQuestion"]>[0],
  ): ReturnType<InterviewAgents["generateNextQuestion"]> {
    try {
      return await this.interviewAgents.generateNextQuestion(input);
    } catch {
      return {
        status: "failure",
        code: "agent_unexpected_error",
        message: "Unexpected InterviewAgents failure",
        retryable: false,
        generation: emptyGeneration(CORE_LOOP_V1_POLICY.questionContractVersion),
      };
    }
  }

  private reserveOperation(
    sessionId: string,
    session: InternalSession,
    operation: SessionOperation,
  ): ReservedOperation | null {
    const operationToken = this.createOperationToken();
    const timestamp = this.now();
    const nextState = sessionStateV2Schema.parse({
      ...session.state,
      activeOperation: {
        type: operation,
        token: operationToken,
        priorPhase: session.state.phase,
        startedAt: timestamp.toISOString(),
      },
      failedOperation: null,
    });
    const event = parseTimelineEvent({
      sequence: this.nextSequence(sessionId),
      type: "operation_started",
      payload: { operation },
      createdAt: timestamp.toISOString(),
    });
    const committed = this.database.transaction(() => {
      const update = this.database
        .prepare(
          `update sessions set state_json = ?, operation_token = ?, version = version + 1, updated_at = ?
           where id = ? and version = ? and operation_token is null`,
        )
        .run(
          JSON.stringify(nextState),
          operationToken,
          timestamp.getTime(),
          sessionId,
          session.row.version,
        );
      if (update.changes !== 1) return false;
      this.insertTimelineEvent(sessionId, event);
      return true;
    })();
    return committed ? { operationToken, state: nextState, event } : null;
  }

  private commitPlan(
    command: Extract<SessionCommand, { type: "generate_plan" }>,
    reserved: ReservedOperation,
    record: NonNullable<SessionStateV2["planRecord"]>,
  ): DispatchResult {
    const timestamp = this.now();
    const chain = record.plan.attackChains[0];
    const nextState = sessionStateV2Schema.parse({
      ...reserved.state,
      phase: "planned",
      planRecord: record,
      execution: null,
      activeOperation: null,
      failedOperation: null,
    });
    const event = parseTimelineEvent({
      sequence: reserved.event.sequence + 1,
      type: "interview_plan_generated",
      payload: { status: chain.status, plan: record.plan, generation: record.generation },
      createdAt: timestamp.toISOString(),
    });
    return this.commitSuccessfulOperation(command, reserved, nextState, [event], timestamp);
  }

  private commitSessionStart(
    command: Extract<SessionCommand, { type: "start" }>,
    reserved: ReservedOperation,
    chain: ReadyAttackChain,
    execution: NonNullable<SessionStateV2["execution"]>,
    generation: GenerationMetadata,
  ): DispatchResult {
    const timestamp = this.now();
    const nextState = sessionStateV2Schema.parse({
      ...reserved.state,
      phase: "active",
      execution,
      activeOperation: null,
      failedOperation: null,
    });
    const sessionStarted = parseTimelineEvent({
      sequence: reserved.event.sequence + 1,
      type: "session_started",
      payload: { chainId: chain.id },
      createdAt: timestamp.toISOString(),
    });
    const turn = execution.turns[0];
    const questionPresented = parseTimelineEvent({
      sequence: reserved.event.sequence + 2,
      type: "question_presented",
      payload: {
        chainId: chain.id,
        turn: {
          id: turn.id,
          ordinal: turn.ordinal,
          status: turn.status,
          question: turn.question,
          createdAt: turn.createdAt,
          settledAt: turn.settledAt,
          answer: turn.answer,
        },
        generation,
      },
      createdAt: timestamp.toISOString(),
    });
    return this.commitSuccessfulOperation(
      command,
      reserved,
      nextState,
      [sessionStarted, questionPresented],
      timestamp,
    );
  }

  private commitSuccessfulOperation(
    command: Extract<SessionCommand, { type: "generate_plan" | "start" }>,
    reserved: ReservedOperation,
    nextState: SessionStateV2,
    domainEvents: TimelineEvent[],
    timestamp: Date,
  ): DispatchResult {
    const result = this.database.transaction((): DispatchResult | null => {
      const update = this.database
        .prepare(
          `update sessions
           set status = ?, state_json = ?, operation_token = null, version = version + 1, updated_at = ?
           where id = ? and operation_token = ?`,
        )
        .run(
          nextState.phase,
          JSON.stringify(nextState),
          timestamp.getTime(),
          command.sessionId,
          reserved.operationToken,
        );
      if (update.changes !== 1) return null;
      for (const event of domainEvents) this.insertTimelineEvent(command.sessionId, event);
      const applied: DispatchResult = {
        status: "applied",
        session: this.get(command.sessionId),
        events: [reserved.event, ...domainEvents],
      };
      this.insertIdempotency(command, timestamp, applied);
      return applied;
    })();
    return (
      result ?? {
        status: "rejected",
        error: { code: "operation_conflict", message: "Session changed before operation commit" },
      }
    );
  }

  private commitOperationFailure(input: {
    command: Extract<SessionCommand, { type: "generate_plan" | "start" }>;
    reserved: ReservedOperation;
    code: string;
    retryable: boolean;
    generation: GenerationMetadata;
    rejectionCounts: Record<string, number>;
    lastRejectionReason: string | null;
    details?: SessionCommandError["details"];
  }): DispatchResult {
    const {
      command,
      reserved,
      code,
      retryable,
      generation,
      rejectionCounts,
      lastRejectionReason,
      details,
    } = input;
    const timestamp = this.now();
    const activeOperation = reserved.state.activeOperation!;
    const userMessage = localizedFailureMessage(
      reserved.state.interviewLanguage,
      activeOperation.type,
      code,
    );
    const nextState = sessionStateV2Schema.parse({
      ...reserved.state,
      phase: "error",
      activeOperation: null,
      failedOperation: {
        type: activeOperation.type,
        priorPhase: activeOperation.priorPhase,
        operationToken: reserved.operationToken,
        code,
        userMessage,
        retrySafety: retryable ? "safe_to_retry" : "manual_review",
        rejectionCounts,
        lastRejectionReason,
        generation,
      },
    });
    const event = parseTimelineEvent({
      sequence: reserved.event.sequence + 1,
      type: "operation_failed",
      payload: {
        operation: activeOperation.type,
        code,
        userMessage,
        retryable,
        usage: generation.usage,
        rejectionCounts,
        lastRejectionReason,
      },
      createdAt: timestamp.toISOString(),
    });
    const result: DispatchResult = {
      status: "rejected",
      error: { code, message: userMessage, retryable, details },
    };
    const committed = this.database.transaction(() => {
      const update = this.database
        .prepare(
          `update sessions
           set status = 'error', state_json = ?, operation_token = null,
               version = version + 1, updated_at = ?
           where id = ? and operation_token = ?`,
        )
        .run(
          JSON.stringify(nextState),
          timestamp.getTime(),
          command.sessionId,
          reserved.operationToken,
        );
      if (update.changes !== 1) return false;
      this.insertTimelineEvent(command.sessionId, event);
      this.insertIdempotency(command, timestamp, result);
      return true;
    })();
    return committed
      ? result
      : {
          status: "rejected",
          error: { code: "operation_conflict", message: "Session changed before failure commit" },
        };
  }

  private recoverInterruptedOperations(): void {
    const rows = this.database
      .prepare(
        `select id, source_profile_id, profile_snapshot_json, status, state_json, version,
                operation_token, created_at, updated_at
         from sessions where operation_token is not null`,
      )
      .all() as SessionRow[];
    for (const row of rows) {
      const session = this.parseInternal(row);
      const active = session.state.activeOperation;
      if (!active) continue;
      const timestamp = this.now();
      const userMessage = localizedFailureMessage(
        session.state.interviewLanguage,
        active.type,
        "operation_interrupted",
      );
      const nextState = sessionStateV2Schema.parse({
        ...session.state,
        phase: "error",
        activeOperation: null,
        failedOperation: {
          type: active.type,
          priorPhase: active.priorPhase,
          operationToken: active.token,
          code: "operation_interrupted",
          userMessage,
          retrySafety: "safe_to_retry",
          rejectionCounts: {},
          lastRejectionReason: null,
          generation: emptyGeneration(
            active.type === "generate_plan"
              ? session.state.policy.plannerContractVersion
              : session.state.policy.questionContractVersion,
          ),
        },
      });
      const event = parseTimelineEvent({
        sequence: this.nextSequence(row.id),
        type: "operation_failed",
        payload: {
          operation: active.type,
          code: "operation_interrupted",
          userMessage,
          retryable: true,
          usage: EMPTY_USAGE,
          rejectionCounts: {},
          lastRejectionReason: null,
        },
        createdAt: timestamp.toISOString(),
      });
      this.database.transaction(() => {
        const update = this.database
          .prepare(
            `update sessions set status = 'error', state_json = ?, operation_token = null,
             version = version + 1, updated_at = ? where id = ? and operation_token = ?`,
          )
          .run(JSON.stringify(nextState), timestamp.getTime(), row.id, active.token);
        if (update.changes === 1) this.insertTimelineEvent(row.id, event);
      })();
    }
  }

  private findSessionOrReject(
    command: SessionCommand,
  ): InternalSession | Extract<DispatchResult, { status: "rejected" }> {
    try {
      return this.getInternal(command.sessionId);
    } catch {
      return this.commitRejection(command, {
        status: "rejected",
        error: { code: "session_not_found", message: `Session not found: ${command.sessionId}` },
      });
    }
  }

  private invalidState(action: string, phase: SessionPhase): Extract<DispatchResult, { status: "rejected" }> {
    return {
      status: "rejected",
      error: { code: "invalid_session_state", message: `Cannot ${action} while Session is ${phase}` },
    };
  }

  private sessionBusy(action: string): DispatchResult {
    return {
      status: "rejected",
      error: { code: "session_busy", message: `Cannot ${action} while another operation is active` },
    };
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
    if (!found) return null;
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
  ): Extract<DispatchResult, { status: "rejected" }> {
    this.insertIdempotency(command, this.now(), result);
    return result;
  }

  private nextSequence(sessionId: string): number {
    const row = this.database
      .prepare(
        "select coalesce(max(sequence), 0) + 1 as sequence from session_timeline where session_id = ?",
      )
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
