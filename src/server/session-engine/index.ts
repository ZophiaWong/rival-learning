import { requestAccounting } from "@/server/interview-agents/role-runner/accounting";
import { normalizeQuestionV1 } from "@/server/core-loop/question-normalizer";
import { calibrationSchema, rechallengePreparationSchema, rechallengeEvaluationSchema, rechallengeHintSchema } from "@/server/core-loop/learning";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import {
  acceptNextQuestionCandidate,
  completeAtPlannedDepth,
  createAttackChainExecutionState,
  settleQuestionTurn,
  takeOverQuestionTurn,
  type QuestionSemanticRejectionReason,
} from "@/server/core-loop/attack-chain-execution";
import {
  materializeBenchmarkBatchCandidate,
  materializeCheckpointReportCandidate,
  materializeTurnEvaluationCandidate,
  type BenchmarkSemanticRejectionReason,
  type CheckpointSemanticRejectionReason,
  type EvaluationSemanticRejectionReason,
} from "@/server/core-loop/checkpoint";
import {
  answerTextSchema,
  generationMetadataSchema,
  type BenchmarkBatch,
  type GenerationMetadata,
  type GenerationUsage,
  type InterviewLanguage,
  type QuestionTurn,
  type ReadyAttackChain,
  type TurnEvaluation,
} from "@/server/core-loop/domain";
import {
  materializeInterviewPlanCandidate,
  measurePlanningInput,
  type PlanSemanticRejectionReason,
  type PlanningInputSizes,
} from "@/server/core-loop/grounding";
import { CORE_LOOP_V3_POLICY, createCoreLoopPolicySnapshot } from "@/server/core-loop/policy";
import type { InterviewAgents, PublicTranscriptTurn } from "@/server/interview-agents";
import {
  ProfileNotFoundError,
  ProviderViewNotConfirmedError,
  type PreparationProfiles,
  type ProfileSnapshot,
} from "@/server/preparation-profiles";
import {
  projectSessionState,
  projectCheckpoint,
  sessionStateV4Schema,
  type CheckpointStage,
  type PublicSessionState,
  type SessionOperation,
  type SessionPhase,
  type SessionStateV4,
} from "./state";
import {
  parseTimelineEvent,
  type TimelineEvent,
} from "./timeline";

export type { TimelineEvent } from "./timeline";
export type { PublicSessionState } from "./state";

export type SessionStatus = SessionPhase;

export class SessionNotFoundError extends Error {
  readonly code = "session_not_found";

  constructor(readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export interface SessionView {
  id: string;
  sourceProfileId: string | null;
  profileSnapshot: ProfileSnapshot;
  status: SessionStatus;
  state: PublicSessionState;
  usage: GenerationUsage & { limit: number };
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type SessionCommand =
  | { type: "calibrate_finding"; sessionId: string; idempotencyKey: string; findingId: string; calibration: "accurate" | "partial" | "inaccurate" }
  | { type: "submit_rechallenge_answer"; sessionId: string; idempotencyKey: string; answer: string }
  | { type: "add_reflection"; sessionId: string; idempotencyKey: string; turnId: string; text: string }
  | { type: "prepare_rechallenge"; sessionId: string; idempotencyKey: string }
  | { type: "evaluate_rechallenge"; sessionId: string; idempotencyKey: string }
  | { type: "generate_hint"; sessionId: string; idempotencyKey: string }
  | { type: "skip_rechallenge"; sessionId: string; idempotencyKey: string }
  | { type: "finish_rechallenge"; sessionId: string; idempotencyKey: string }
  | { type: "extend_budget"; sessionId: string; idempotencyKey: string }
  | { type: "resume_error"; sessionId: string; idempotencyKey: string }

  | {
      type: "create_session";
      sessionId: string;
      profileId: string;
      interviewLanguage: InterviewLanguage;
      idempotencyKey: string;
    }
  | { type: "generate_plan"; sessionId: string; idempotencyKey: string }
  | { type: "start"; sessionId: string; idempotencyKey: string }
  | { type: "request_ai_answer"; sessionId: string; idempotencyKey: string }
  | { type: "request_next_question"; sessionId: string; idempotencyKey: string }
  | { type: "generate_checkpoint"; sessionId: string; idempotencyKey: string }
  | { type: "take_over"; sessionId: string; idempotencyKey: string }
  | {
      type: "submit_human_answer";
      sessionId: string;
      answer: string;
      idempotencyKey: string;
    };

export type ActionUnavailableReason =
  | "session_not_active"
  | "session_in_error"
  | "no_pending_question"
  | "question_already_settled"
  | "answer_pending"
  | "attack_chain_completed"
  | "candidate_control_required"
  | "human_control_required"
  | "human_already_controls"
  | "attack_chain_not_completed"
  | "no_human_answers"
  | "checkpoint_already_generated";

export interface SessionCommandError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: {
    fieldSizes?: PlanningInputSizes;
    rejectionCounts?: Record<string, number>;
    lastRejectionReason?: string | null;
    reason?: ActionUnavailableReason | "empty" | "too_long";
    stage?: CheckpointStage;
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
  state: SessionStateV4;
  usage: SessionView["usage"];
}

interface ReservedOperation {
  sessionId: string;
  operationToken: string;
  state: SessionStateV4;
  event: TimelineEvent;
}

const EMPTY_USAGE: GenerationUsage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  usageComplete: true,
};

function commandFingerprint(command: SessionCommand): string {
  const payload = (() => {
    if (command.type === "create_session") {
      return {
        type: command.type,
        sessionId: command.sessionId,
        profileId: command.profileId,
        interviewLanguage: command.interviewLanguage,
      };
    }
    if (command.type === "calibrate_finding") {
      return { type: command.type, sessionId: command.sessionId, findingId: command.findingId, calibration: command.calibration };
    }
    if (command.type === "add_reflection") {
      return { type: command.type, sessionId: command.sessionId, turnId: command.turnId, text: command.text.trim() };
    }
    if (command.type === "submit_human_answer" || command.type === "submit_rechallenge_answer") {
      return { type: command.type, sessionId: command.sessionId, answer: command.answer.trim() };
    }
    return { type: command.type, sessionId: command.sessionId };
  })();
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

function settledPublicTranscript(
  execution: NonNullable<SessionStateV4["execution"]>,
): PublicTranscriptTurn[] {
  return execution.turns
    .filter((turn) => turn.status === "settled" && turn.answer)
    .map((turn) => ({
      question: turn.question.text,
      answer: turn.answer ? { actor: turn.answer.actor, text: turn.answer.text } : null,
    }));
}

function humanTurns(
  execution: NonNullable<SessionStateV4["execution"]>,
): QuestionTurn[] {
  return execution.turns
    .filter(
      (turn): turn is QuestionTurn & { answer: { actor: "human"; text: string } } =>
        turn.status === "settled" && turn.answer?.actor === "human",
    )
    .sort((left, right) => left.ordinal - right.ordinal);
}

function publicTranscriptBefore(
  execution: NonNullable<SessionStateV4["execution"]>,
  turnId: string,
): PublicTranscriptTurn[] {
  const index = execution.turns.findIndex((turn) => turn.id === turnId);
  return settledPublicTranscript({
    ...execution,
    turns: index < 0 ? [] : execution.turns.slice(0, index),
  });
}

function contractVersionForOperation(
  policy: SessionStateV4["policy"],
  operation: SessionOperation,
  checkpointStage: CheckpointStage | null = null,
): GenerationMetadata["contractVersion"] {
  if (["prepare_rechallenge", "evaluate_rechallenge", "generate_hint"].includes(operation)) return "rechallenge-v1";
  if (operation === "generate_plan") return policy.plannerContractVersion;
  if (operation === "request_ai_answer") return policy.candidateAnswerContractVersion;
  if (operation === "generate_checkpoint") {
    if (checkpointStage === "benchmarking") return policy.benchmarkContractVersion;
    if (checkpointStage === "synthesizing") return policy.checkpointContractVersion;
    return policy.judgeEvaluationContractVersion;
  }
  return policy.questionContractVersion;
}

function localizedFailureMessage(
  language: InterviewLanguage,
  operation: SessionOperation,
  code: string,
): string {
  if (code === "invalid_learning_result") return language === "zh-CN" ? "模型返回的训练内容未通过校验，请恢复并重试。" : "The learning response failed validation. Resume to try again.";
  if (code === "budget_exhausted") return language === "zh-CN" ? "请求预算已用完，请增加 20 次后继续。" : "Request budget exhausted. Add 20 requests to continue.";
  const operationLabel = (() => {
    if (["prepare_rechallenge", "evaluate_rechallenge", "generate_hint"].includes(operation)) return "Rechallenge";
    if (operation === "generate_plan") return language === "zh-CN" ? "面试计划" : "interview plan";
    if (operation === "start") return language === "zh-CN" ? "首个问题" : "first question";
    if (operation === "request_ai_answer") {
      return language === "zh-CN" ? "Candidate 回答" : "Candidate answer";
    }
    if (operation === "generate_checkpoint") {
      return language === "zh-CN" ? "Checkpoint" : "Checkpoint";
    }
    return language === "zh-CN" ? "下一问题" : "next question";
  })();
  if (language === "zh-CN") {
    if (code === "input_too_large") return "准备资料超过本版本可处理的长度，请缩短后创建新 Session。";
    if (code === "semantic_candidates_exhausted") {
      return operation === "generate_plan"
        ? "模型未能生成可验证的面试计划，请补充更具体的资料。"
        : `模型未能生成有效的${operationLabel}。`;
    }
    if (code === "operation_interrupted") return `上一次${operationLabel}操作被中断。`;
    return `${operationLabel}生成失败，请检查模型配置。`;
  }
  if (code === "input_too_large") {
    return "The preparation material exceeds this version's limit. Shorten it and create a new Session.";
  }
  if (code === "semantic_candidates_exhausted") {
    return operation === "generate_plan"
      ? "The model did not produce a verifiable interview plan. Add more concrete evidence."
      : `The model did not produce a valid ${operationLabel}.`;
  }
  if (code === "operation_interrupted") {
    return `The previous ${operationLabel} operation was interrupted.`;
  }
  return `${operationLabel} generation failed. Check the model configuration.`;
}

function mapSession(session: InternalSession): SessionView {
  return {
    id: session.row.id,
    usage: session.usage,
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
    return requestAccounting.run({
      reserve: () => this.reserveRequest(command.sessionId, command.idempotencyKey),
      settle: (id, input, output) => { this.database.prepare(
        "update model_requests set input_tokens = ?, output_tokens = ?, usage_complete = ? where id = ?"
      ).run(input, output, input !== null && output !== null ? 1 : 0, id); },
    }, () => this.dispatchCommand(command));
  }

  private async dispatchCommand(command: SessionCommand): Promise<DispatchResult> {
    const replay = this.findIdempotencyResult(command);
    if (replay) return replay;
    if (command.type !== "create_session") {
      const current = this.findSessionOrReject(command);
      if ("status" in current) return current;
      if (current.state.phase === "budget_paused" && command.type !== "extend_budget")
        return this.commitRejection(command, { status: "rejected", error: { code: "budget_paused", message: "请增加 20 次请求预算后继续。" } });
    }
    if (["prepare_rechallenge", "evaluate_rechallenge", "generate_hint"].includes(command.type))
      return this.runLearningOperation(command as Extract<SessionCommand, { type: "prepare_rechallenge" | "evaluate_rechallenge" | "generate_hint" }>);
    if (["calibrate_finding", "submit_rechallenge_answer", "add_reflection", "skip_rechallenge", "finish_rechallenge", "extend_budget", "resume_error"].includes(command.type))
      return this.learningAction(command);
    if (command.type === "create_session") return this.createSession(command);
    if (command.type === "generate_plan") return this.generatePlan(command);
    if (command.type === "start") return this.startSession(command);
    if (command.type === "request_ai_answer") return this.requestAiAnswer(command);
    if (command.type === "request_next_question") return this.requestNextQuestion(command);
    if (command.type === "generate_checkpoint") return this.generateCheckpoint(command);
    if (command.type === "take_over") return this.takeOver(command);
    return this.submitHumanAnswer(command as Extract<SessionCommand, { type: "submit_human_answer" }>);
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

  private requestUsage(sessionId: string, limit: number): SessionView["usage"] {
    const row = this.database.prepare(`select count(*) as requests,
      coalesce(sum(input_tokens), 0) as inputTokens, coalesce(sum(output_tokens), 0) as outputTokens,
      count(case when usage_complete = 0 then 1 end) as incomplete
      from model_requests where session_id = ?`).get(sessionId) as {
        requests: number; inputTokens: number; outputTokens: number; incomplete: number;
      };
    return { requests: row.requests, inputTokens: row.inputTokens, outputTokens: row.outputTokens,
      usageComplete: row.incomplete === 0, limit };
  }

  private reserveRequest(sessionId: string, idempotencyKey: string): string | null {
    return this.database.transaction(() => {
      const session = this.getInternal(sessionId);
      if (!session.row.operation_token || session.state.activeOperation?.idempotencyKey !== idempotencyKey || session.usage.requests >= session.usage.limit) return null;
      const id = randomUUID();
      this.database.prepare("insert into model_requests (id, session_id, operation_token) values (?, ?, ?)")
        .run(id, sessionId, session.row.operation_token);
      return id;
    }).immediate();
  }

  private learningAction(command: SessionCommand): DispatchResult {
    const replay = this.findIdempotencyResult(command);
    if (replay) return replay;
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token) return this.sessionBusy(command.type);
    const state = sessionStateV4Schema.parse(session.state);
    const reject = (message: string) => this.commitRejection(command, {
      status: "rejected", error: { code: "learning_action_not_available", message },
    });
    const commit = (type: TimelineEvent["type"], payload: TimelineEvent["payload"]) =>
      this.commitSynchronousCommand(command, session, state, [{ type, payload }]);
    if (command.type === "extend_budget") {
      if (state.phase !== "budget_paused") return reject("预算尚未暂停。");
      state.budgetLimit += 20;
      // Keep the saved operation until the explicit resume action.
      state.phase = "error";
      return commit("budget_extended", { limit: state.budgetLimit, added: 20 });
    }
    if (command.type === "resume_error") {
      if (state.phase !== "error" || !state.failedOperation) return reject("没有可恢复的操作。");
      const operation = state.failedOperation.type;
      state.phase = state.failedOperation.priorPhase;
      state.failedOperation = null;
      return commit("operation_resumed", { operation });
    }
    if (command.type === "add_reflection") {
      const text = answerTextSchema.safeParse(command.text);
      const turn = state.execution?.turns.find(turn => turn.id === command.turnId);
      if (!text.success || turn?.answer?.actor !== "human") return reject("只能为已提交的个人回答追加复盘。");
      return commit("reflection_added", { turnId: command.turnId, text: text.data });
    }
    if (state.phase !== "active" || state.checkpoint?.status !== "completed" || !state.checkpoint.result)
      return reject("请先完成 Checkpoint。");
    const checkpoint = state.checkpoint.result;
    if (command.type === "calibrate_finding") {
      const finding = checkpoint.findings.find(item => item.id === command.findingId);
      const parsed = calibrationSchema.safeParse(command.calibration);
      if (!finding || !parsed.success) return reject("无效的差距校准。");
      if (finding.calibration !== "unreviewed") {
        if (finding.calibration !== parsed.data) return reject("该差距已完成校准。");
        return this.commitSynchronousCommand(command, session, state, []);
      }
      finding.calibration = parsed.data;
      if (parsed.data !== "inaccurate") state.learning.gaps.push({
        id: this.createEntityId(), findingId: finding.id, targetDimension: finding.targetDimension,
        priority: finding.priority, status: "open",
      });
      return commit("finding_calibrated", { findingId: finding.id, calibration: parsed.data });
    }
    const challenge = state.learning.rechallenge;
    if (!challenge || challenge.outcome) return reject("没有待完成的 Rechallenge。");
    const gap = state.learning.gaps.find(item => item.id === challenge.gapId)!;
    if (command.type === "submit_rechallenge_answer") {
      const answer = answerTextSchema.safeParse(command.answer);
      const last = challenge.attempts.at(-1);
      if (!answer.success || (last && (!last.evaluation || !challenge.hint)) || challenge.attempts.length >= 2)
        return reject("请完成当前回答的评价；再次作答需要先使用一次 L1 提示。");
      challenge.attempts.push({ answer: answer.data, hinted: challenge.hint !== null, evaluation: null });
    } else if (command.type === "skip_rechallenge") {
      if (challenge.attempts.some(attempt => !attempt.evaluation)) return reject("请先评价已提交的回答。");
      gap.status = "deferred";
      challenge.outcome = "deferred";
    } else if (command.type === "finish_rechallenge") {
      if (!challenge.attempts.at(-1)?.evaluation || challenge.attempts.at(-1)!.evaluation!.covered)
        return reject("请先完成一次回答评价。");
      gap.status = "unresolved";
      challenge.outcome = "unresolved";
    } else return reject("未知学习操作。");
    return commit("learning_updated", { action: command.type, learning: state.learning });
  }

  private async runLearningOperation(command: Extract<SessionCommand, {
    type: "prepare_rechallenge" | "evaluate_rechallenge" | "generate_hint"
  }>): Promise<DispatchResult> {
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token) return this.sessionBusy(command.type);
    const state = session.state;
    const checkpoint = state.checkpoint?.result;
    const challenge = state.learning.rechallenge;
    const gap = challenge ? state.learning.gaps.find(item => item.id === challenge.gapId)
      : [...state.learning.gaps].sort((a, b) => a.priority - b.priority)[0];
    const reject = (message: string) => this.commitRejection(command, {
      status: "rejected", error: { code: "learning_action_not_available", message },
    });
    if (state.phase !== "active" || !checkpoint || !gap || !state.planRecord?.questionContext ||
        checkpoint.findings.some(finding => finding.calibration === "unreviewed"))
      return reject("请先完成全部差距校准，并至少接受一个差距。");
    if (command.type === "prepare_rechallenge" && challenge) return reject("本次即时 Rechallenge 已生成。");
    if (command.type !== "prepare_rechallenge" && (!challenge || challenge.outcome))
      return reject("没有待处理的 Rechallenge。");
    const attempt = challenge?.attempts.at(-1);
    if (command.type === "evaluate_rechallenge" && (!attempt || attempt.evaluation))
      return reject("没有待评价的回答。");
    if (command.type === "generate_hint" && (challenge!.hint || !attempt?.evaluation || attempt.evaluation.covered))
      return reject("第一次无提示回答未覆盖目标维度后，可以使用一次 L1 提示。");
    const reserved = this.reserveOperation(command, session);
    if (!reserved) return this.sessionBusy(command.type);
    const finding = checkpoint.findings.find(item => item.id === gap.findingId)!;
    const common = { interviewLanguage: state.interviewLanguage,
      targetRole: session.profileSnapshot.providerView.targetRole,
      targetLevel: session.profileSnapshot.providerView.targetLevel, targetDimension: gap.targetDimension };
    let generation = emptyGeneration("rechallenge-v1");
    try {
      const result = command.type === "prepare_rechallenge"
        ? await this.interviewAgents.prepareRechallenge({ ...common, findingSummary: finding.summary,
            originalQuestions: state.execution!.turns.map(turn => turn.question.text),
            evidenceContext: state.planRecord.questionContext })
        : command.type === "generate_hint"
          ? await this.interviewAgents.generateHint({ ...common, question: challenge!.preparation.question })
          : await this.interviewAgents.evaluateRechallenge({ ...common, question: challenge!.preparation.question, answer: attempt!.answer });
      generation = result.generation;
      if (result.status === "failure") return this.commitOperationFailure({ command, reserved,
        code: result.code, retryable: result.retryable, generation, rejectionCounts: {}, lastRejectionReason: null });
      const next = sessionStateV4Schema.parse(reserved.state);
      if (command.type === "prepare_rechallenge") {
        const preparation = rechallengePreparationSchema.parse(result.value);
        if (preparation.targetDimension !== gap.targetDimension ||
          state.execution!.turns.some(turn => normalizeQuestionV1(turn.question.text) === normalizeQuestionV1(preparation.question)))
          throw new Error("Invalid transfer question");
        next.learning.rechallenge = { gapId: gap.id, preparation, hint: null, attempts: [], outcome: null };
      } else if (command.type === "generate_hint") {
        next.learning.rechallenge!.hint = rechallengeHintSchema.parse(result.value).hint;
      } else {
        const evaluation = rechallengeEvaluationSchema.parse(result.value);
        if (evaluation.answerExcerpts.some(excerpt => !attempt!.answer.includes(excerpt)) ||
            (evaluation.covered && evaluation.answerExcerpts.length === 0)) throw new Error("Invalid answer evidence");
        const nextChallenge = next.learning.rechallenge!;
        const nextAttempt = nextChallenge.attempts.at(-1)!;
        nextAttempt.evaluation = evaluation;
        const nextGap = next.learning.gaps.find(item => item.id === gap.id)!;
        if (evaluation.covered) {
          nextGap.status = nextAttempt.hinted ? "assisted_correction" : "improved";
          nextChallenge.outcome = nextAttempt.hinted ? "AssistedCorrection" : "ProximalImprovement";
        } else {
          nextGap.status = "unresolved";
          if (nextAttempt.hinted) nextChallenge.outcome = "unresolved";
        }
      }
      next.activeOperation = null;
      next.failedOperation = null;
      const timestamp = this.now();
      const event = parseTimelineEvent({ sequence: reserved.event.sequence + 1,
        type: "learning_updated", payload: { action: command.type, learning: next.learning, generation }, createdAt: timestamp.toISOString() });
      return this.commitSuccessfulOperation(command, reserved, next, [event], timestamp);
    } catch {
      return this.commitOperationFailure({ command, reserved, code: "invalid_learning_result",
        retryable: true, generation, rejectionCounts: {}, lastRejectionReason: null });
    }
  }

  private getInternal(sessionId: string): InternalSession {
    const row = this.database
      .prepare(
        `select id, source_profile_id, profile_snapshot_json, status, state_json, version,
                operation_token, created_at, updated_at
         from sessions where id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) throw new SessionNotFoundError(sessionId);
    return this.parseInternal(row);
  }

  private parseInternal(row: SessionRow): InternalSession {
    return {
      row,
      profileSnapshot: JSON.parse(row.profile_snapshot_json) as ProfileSnapshot,
      state: sessionStateV4Schema.parse(JSON.parse(row.state_json) as unknown),
      usage: this.requestUsage(row.id, sessionStateV4Schema.parse(JSON.parse(row.state_json)).budgetLimit),
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
    const state = sessionStateV4Schema.parse({
      stateVersion: 4,
      phase: "draft",
      interviewLanguage: command.interviewLanguage,
      policy: createCoreLoopPolicySnapshot(),
      planRecord: null,
      execution: null,
      checkpoint: null,
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

    const reserved = this.reserveOperation(command, session);
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

    const reserved = this.reserveOperation(command, session);
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
        publicTranscript: settledPublicTranscript(initialExecution),
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

  private async requestAiAnswer(
    command: Extract<SessionCommand, { type: "request_ai_answer" }>,
  ): Promise<DispatchResult> {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) return idempotencyResult;
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token || session.state.activeOperation) {
      return this.sessionBusy("request a Candidate answer");
    }
    if (session.state.phase !== "active") {
      const reason = session.state.phase === "error" ? "session_in_error" : "session_not_active";
      return this.commitRejection(
        command,
        this.actionUnavailable("request_ai_answer", reason),
      );
    }
    const execution = session.state.execution;
    if (!execution || !session.state.planRecord?.questionContext) {
      return this.commitRejection(
        command,
        this.actionUnavailable("request_ai_answer", "no_pending_question"),
      );
    }
    const activeTurn = execution.turns.at(-1);
    if (execution.status === "completed") {
      return this.commitRejection(
        command,
        this.actionUnavailable("request_ai_answer", "attack_chain_completed"),
      );
    }
    if (execution.status !== "awaiting_answer" || !activeTurn || activeTurn.status !== "awaiting_answer") {
      return this.commitRejection(
        command,
        this.actionUnavailable("request_ai_answer", "question_already_settled"),
      );
    }
    if (execution.answerMode !== "a2a") {
      return this.commitRejection(
        command,
        this.actionUnavailable("request_ai_answer", "candidate_control_required"),
      );
    }

    const reserved = this.reserveOperation(command, session);
    if (!reserved) return this.sessionBusy("request a Candidate answer");
    const candidate = await this.safeCandidateAnswer({
      operationToken: reserved.operationToken,
      interviewLanguage: reserved.state.interviewLanguage,
      questionContext: session.state.planRecord.questionContext,
      jobDescription: session.profileSnapshot.providerView.jobDescription,
      targetRole: session.profileSnapshot.providerView.targetRole,
      targetLevel: session.profileSnapshot.providerView.targetLevel,
      currentQuestion: activeTurn.question.text,
      publicTranscript: settledPublicTranscript(execution),
    });
    if (candidate.status === "failure") {
      return this.commitOperationFailure({
        command,
        reserved,
        code: candidate.code,
        retryable: candidate.retryable,
        generation: candidate.generation,
        rejectionCounts: {},
        lastRejectionReason: null,
      });
    }
    const settled = settleQuestionTurn({
      state: reserved.state.execution!,
      questionTurnId: activeTurn.id,
      actor: "candidate",
      answer: candidate.value.text,
      generation: candidate.generation,
      now: this.now().toISOString(),
    });
    if (settled.status === "rejected") {
      return this.commitOperationFailure({
        command,
        reserved,
        code: "candidate_answer_rejected",
        retryable: false,
        generation: candidate.generation,
        rejectionCounts: { [settled.reason]: 1 },
        lastRejectionReason: settled.reason,
      });
    }
    const chain = session.state.planRecord.plan.attackChains[0];
    if (chain.status !== "ready") {
      return this.commitOperationFailure({
        command,
        reserved,
        code: "attack_chain_not_ready",
        retryable: false,
        generation: candidate.generation,
        rejectionCounts: {},
        lastRejectionReason: null,
      });
    }
    const completion = completeAtPlannedDepth({
      state: settled.state,
      chain,
      policy: reserved.state.policy,
      interviewLanguage: reserved.state.interviewLanguage,
      now: this.now().toISOString(),
    });
    const executionAfterAnswer = completion?.status === "accepted" ? completion.state : settled.state;
    const pendingEvents = [
      ...settled.events,
      ...(completion?.status === "accepted" ? completion.events : []),
    ];
    return this.commitCoreLoopOperation(command, reserved, executionAfterAnswer, pendingEvents);
  }

  private async requestNextQuestion(
    command: Extract<SessionCommand, { type: "request_next_question" }>,
  ): Promise<DispatchResult> {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) return idempotencyResult;
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token || session.state.activeOperation) {
      return this.sessionBusy("request the next question");
    }
    if (session.state.phase !== "active") {
      const reason = session.state.phase === "error" ? "session_in_error" : "session_not_active";
      return this.commitRejection(
        command,
        this.actionUnavailable("request_next_question", reason),
      );
    }
    const execution = session.state.execution;
    const record = session.state.planRecord;
    if (!execution || !record?.questionContext) {
      return this.commitRejection(
        command,
        this.actionUnavailable("request_next_question", "session_not_active"),
      );
    }
    if (execution.status === "completed") {
      return this.commitRejection(
        command,
        this.actionUnavailable("request_next_question", "attack_chain_completed"),
      );
    }
    if (execution.status !== "ready_for_next_question") {
      return this.commitRejection(
        command,
        this.actionUnavailable("request_next_question", "answer_pending"),
      );
    }
    const chain = record.plan.attackChains[0];
    if (chain.status !== "ready") {
      return this.commitRejection(
        command,
        this.actionUnavailable("request_next_question", "session_not_active"),
      );
    }

    const reserved = this.reserveOperation(command, session);
    if (!reserved) return this.sessionBusy("request the next question");
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
        plan: record.plan,
        questionContext: record.questionContext,
        jobDescription: session.profileSnapshot.providerView.jobDescription,
        targetRole: session.profileSnapshot.providerView.targetRole,
        targetLevel: session.profileSnapshot.providerView.targetLevel,
        publicTranscript: settledPublicTranscript(execution),
        currentDifficulty: execution.turns.at(-1)?.question.difficulty ?? null,
        remainingDepth: chain.estimatedDepth - execution.turns.length,
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
        state: reserved.state.execution!,
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
      return this.commitCoreLoopOperation(command, reserved, transition.state, transition.events);
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

  private async generateCheckpoint(
    command: Extract<SessionCommand, { type: "generate_checkpoint" }>,
  ): Promise<DispatchResult> {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) return idempotencyResult;
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token || session.state.activeOperation) {
      return this.sessionBusy("generate Checkpoint");
    }
    if (session.state.phase !== "active") {
      const reason = session.state.phase === "error" ? "session_in_error" : "session_not_active";
      return this.commitRejection(
        command,
        this.actionUnavailable("generate_checkpoint", reason),
      );
    }
    const execution = session.state.execution;
    const record = session.state.planRecord;
    if (!execution || execution.status !== "completed" || !record?.questionContext) {
      return this.commitRejection(
        command,
        this.actionUnavailable("generate_checkpoint", "attack_chain_not_completed"),
      );
    }
    if (session.state.checkpoint?.status === "completed") {
      return this.commitRejection(
        command,
        this.actionUnavailable("generate_checkpoint", "checkpoint_already_generated"),
      );
    }
    const turns = humanTurns(execution);
    if (turns.length === 0) {
      return this.commitRejection(
        command,
        this.actionUnavailable("generate_checkpoint", "no_human_answers"),
      );
    }
    const chain = record.plan.attackChains[0];
    if (chain.status !== "ready") {
      return this.commitRejection(
        command,
        this.actionUnavailable("generate_checkpoint", "session_not_active"),
      );
    }

    let reserved = this.reserveOperation(command, session, session.state.checkpoint ?? {
      status: "evaluating",
      chainId: chain.id,
      humanTurnIds: turns.map((turn) => turn.id),
      evaluations: [],
      benchmarkBatch: null,
      result: null,
      startedAt: this.now().toISOString(),
    });
    if (!reserved) return this.sessionBusy("generate Checkpoint");
    const appliedEvents: TimelineEvent[] = [reserved.event];
    const evaluations: TurnEvaluation[] = [...(reserved.state.checkpoint?.evaluations ?? [])];

    for (const turn of turns.slice(evaluations.length)) {
      const answer = turn.answer;
      if (!answer || answer.actor !== "human") {
        return this.commitOperationFailure({
          command,
          reserved,
          stage: "evaluating",
          code: "human_answer_required",
          retryable: false,
          generation: emptyGeneration(reserved.state.policy.judgeEvaluationContractVersion),
          rejectionCounts: {},
          lastRejectionReason: null,
        });
      }
      let generation = emptyGeneration(reserved.state.policy.judgeEvaluationContractVersion);
      const rejectionCounts: Record<string, number> = {};
      const semanticRejections: string[] = [];
      let lastReason: EvaluationSemanticRejectionReason | null = null;
      let acceptedEvaluation: TurnEvaluation | null = null;
      for (
        let candidateNumber = 1;
        candidateNumber <= reserved.state.policy.maxSemanticCandidatesPerOperation;
        candidateNumber += 1
      ) {
        const candidate = await this.safeTurnEvaluation({
          operationToken: reserved.operationToken,
          interviewLanguage: reserved.state.interviewLanguage,
          rubricVersion: reserved.state.policy.rubricVersion,
          questionContext: record.questionContext,
          jobDescription: session.profileSnapshot.providerView.jobDescription,
          targetRole: session.profileSnapshot.providerView.targetRole,
          targetLevel: session.profileSnapshot.providerView.targetLevel,
          knowledgeTarget: chain.knowledgeTarget,
          currentTurn: {
            id: turn.id,
            question: turn.question.text,
            answer: answer.text,
          },
          priorPublicTranscript: publicTranscriptBefore(execution, turn.id),
          semanticRejections,
        });
        generation = mergeGeneration(generation, candidate.generation);
        if (candidate.status === "failure") {
          return this.commitOperationFailure({
            command,
            reserved,
            stage: "evaluating",
            code: candidate.code,
            retryable: candidate.retryable,
            generation,
            rejectionCounts,
            lastRejectionReason: lastReason,
          });
        }
        const materialized = materializeTurnEvaluationCandidate({
          turn,
          candidate: candidate.value,
          generation,
          rubricVersion: reserved.state.policy.rubricVersion,
          createdAt: this.now().toISOString(),
        });
        if (materialized.status === "rejected") {
          lastReason = materialized.reason;
          incrementCount(rejectionCounts, materialized.reason);
          semanticRejections.push(materialized.reason);
          continue;
        }
        acceptedEvaluation = materialized.evaluation;
        break;
      }
      if (!acceptedEvaluation) {
        return this.commitOperationFailure({
          command,
          reserved,
          stage: "evaluating",
          code: "semantic_candidates_exhausted",
          retryable: true,
          generation,
          rejectionCounts,
          lastRejectionReason: lastReason,
          details: { rejectionCounts, lastRejectionReason: lastReason, stage: "evaluating" },
        });
      }
      evaluations.push(acceptedEvaluation);
      const evaluationEvent = parseTimelineEvent({
        sequence: reserved.event.sequence + 1,
        type: "turn_evaluation_recorded",
        payload: {
          chainId: chain.id,
          turnId: turn.id,
          rubricVersion: reserved.state.policy.rubricVersion,
          generation: acceptedEvaluation.generation,
        },
        createdAt: this.now().toISOString(),
      });
      const nextState = sessionStateV4Schema.parse({
        ...reserved.state,
        checkpoint: {
          ...reserved.state.checkpoint!,
          status: evaluations.length === turns.length ? "benchmarking" : "evaluating",
          evaluations,
        },
      });
      const progressed = this.commitCheckpointProgress(reserved, nextState, evaluationEvent);
      if (!progressed) return this.operationConflict();
      reserved = progressed;
      appliedEvents.push(evaluationEvent);
    }

    let benchmarkGeneration = emptyGeneration(reserved.state.policy.benchmarkContractVersion);
    const benchmarkRejectionCounts: Record<string, number> = {};
    const benchmarkSemanticRejections: string[] = [];
    let benchmarkLastReason: BenchmarkSemanticRejectionReason | null = null;
    let benchmarkBatch: BenchmarkBatch | null = reserved.state.checkpoint?.benchmarkBatch ?? null;
    for (
      let candidateNumber = 1;
      !benchmarkBatch && candidateNumber <= reserved.state.policy.maxSemanticCandidatesPerOperation;
      candidateNumber += 1
    ) {
      const candidate = await this.safeBenchmarks({
        operationToken: reserved.operationToken,
        interviewLanguage: reserved.state.interviewLanguage,
        questionContext: record.questionContext,
        jobDescription: session.profileSnapshot.providerView.jobDescription,
        targetRole: session.profileSnapshot.providerView.targetRole,
        targetLevel: session.profileSnapshot.providerView.targetLevel,
        knowledgeTarget: chain.knowledgeTarget,
        humanQuestions: turns.map((turn) => ({
          turnId: turn.id,
          question: turn.question.text,
          evidenceAnchorIds: turn.question.evidenceAnchorIds,
        })),
        semanticRejections: benchmarkSemanticRejections,
      });
      benchmarkGeneration = mergeGeneration(benchmarkGeneration, candidate.generation);
      if (candidate.status === "failure") {
        return this.commitOperationFailure({
          command,
          reserved,
          stage: "benchmarking",
          code: candidate.code,
          retryable: candidate.retryable,
          generation: benchmarkGeneration,
          rejectionCounts: benchmarkRejectionCounts,
          lastRejectionReason: benchmarkLastReason,
        });
      }
      const materialized = materializeBenchmarkBatchCandidate({
        humanTurns: turns,
        candidate: candidate.value,
        generation: benchmarkGeneration,
        createdAt: this.now().toISOString(),
      });
      if (materialized.status === "rejected") {
        benchmarkLastReason = materialized.reason;
        incrementCount(benchmarkRejectionCounts, materialized.reason);
        benchmarkSemanticRejections.push(materialized.reason);
        continue;
      }
      benchmarkBatch = materialized.batch;
      break;
    }
    if (!benchmarkBatch) {
      return this.commitOperationFailure({
        command,
        reserved,
        stage: "benchmarking",
        code: "semantic_candidates_exhausted",
        retryable: true,
        generation: benchmarkGeneration,
        rejectionCounts: benchmarkRejectionCounts,
        lastRejectionReason: benchmarkLastReason,
        details: {
          rejectionCounts: benchmarkRejectionCounts,
          lastRejectionReason: benchmarkLastReason,
          stage: "benchmarking",
        },
      });
    }
    if (!reserved.state.checkpoint?.benchmarkBatch) {
    const benchmarkEvent = parseTimelineEvent({
      sequence: reserved.event.sequence + 1,
      type: "benchmarks_generated",
      payload: {
        chainId: chain.id,
        turnIds: turns.map((turn) => turn.id),
        count: turns.length,
        generation: benchmarkBatch.generation,
      },
      createdAt: this.now().toISOString(),
    });
    const benchmarkState = sessionStateV4Schema.parse({
      ...reserved.state,
      checkpoint: {
        ...reserved.state.checkpoint!,
        status: "synthesizing",
        benchmarkBatch,
      },
    });
    const benchmarkProgress = this.commitCheckpointProgress(
      reserved,
      benchmarkState,
      benchmarkEvent,
    );
    if (!benchmarkProgress) return this.operationConflict();
    reserved = benchmarkProgress;
    appliedEvents.push(benchmarkEvent);
    }

    let checkpointGeneration = emptyGeneration(reserved.state.policy.checkpointContractVersion);
    const checkpointRejectionCounts: Record<string, number> = {};
    const checkpointSemanticRejections: string[] = [];
    let checkpointLastReason: CheckpointSemanticRejectionReason | null = null;
    for (
      let candidateNumber = 1;
      candidateNumber <= reserved.state.policy.maxSemanticCandidatesPerOperation;
      candidateNumber += 1
    ) {
      const candidate = await this.safeCheckpointReport({
        operationToken: reserved.operationToken,
        interviewLanguage: reserved.state.interviewLanguage,
        questionContext: record.questionContext,
        jobDescription: session.profileSnapshot.providerView.jobDescription,
        targetRole: session.profileSnapshot.providerView.targetRole,
        targetLevel: session.profileSnapshot.providerView.targetLevel,
        knowledgeTarget: chain.knowledgeTarget,
        humanTurns: turns.map((turn) => ({
          turnId: turn.id,
          question: turn.question.text,
          answer: turn.answer!.text,
        })),
        evaluations: evaluations.map((evaluation) => ({
          turnId: evaluation.turnId,
          dimensions: evaluation.dimensions,
        })),
        benchmarks: benchmarkBatch.benchmarks,
        publicTranscript: settledPublicTranscript(execution),
        semanticRejections: checkpointSemanticRejections,
      });
      checkpointGeneration = mergeGeneration(checkpointGeneration, candidate.generation);
      if (candidate.status === "failure") {
        return this.commitOperationFailure({
          command,
          reserved,
          stage: "synthesizing",
          code: candidate.code,
          retryable: candidate.retryable,
          generation: checkpointGeneration,
          rejectionCounts: checkpointRejectionCounts,
          lastRejectionReason: checkpointLastReason,
        });
      }
      const materialized = materializeCheckpointReportCandidate({
        chainId: chain.id,
        humanTurns: turns,
        evaluations,
        benchmarkBatch,
        candidate: candidate.value,
        generation: checkpointGeneration,
        createId: this.createEntityId,
        completedAt: this.now().toISOString(),
      });
      if (materialized.status === "rejected") {
        checkpointLastReason = materialized.reason;
        incrementCount(checkpointRejectionCounts, materialized.reason);
        checkpointSemanticRejections.push(materialized.reason);
        continue;
      }
      const completedState = sessionStateV4Schema.parse({
        ...reserved.state,
        activeOperation: null,
        failedOperation: null,
        checkpoint: {
          ...reserved.state.checkpoint!,
          status: "completed",
          result: materialized.checkpoint,
        },
      });
      const checkpointEvent = parseTimelineEvent({
        sequence: reserved.event.sequence + 1,
        type: "checkpoint_generated",
        payload: {
          checkpoint: projectCheckpoint(materialized.checkpoint),
          generation: materialized.checkpoint.generation,
        },
        createdAt: this.now().toISOString(),
      });
      return this.commitCheckpointSuccess(
        command,
        reserved,
        completedState,
        [...appliedEvents, checkpointEvent],
        checkpointEvent,
      );
    }

    return this.commitOperationFailure({
      command,
      reserved,
      stage: "synthesizing",
      code: "semantic_candidates_exhausted",
      retryable: true,
      generation: checkpointGeneration,
      rejectionCounts: checkpointRejectionCounts,
      lastRejectionReason: checkpointLastReason,
      details: {
        rejectionCounts: checkpointRejectionCounts,
        lastRejectionReason: checkpointLastReason,
        stage: "synthesizing",
      },
    });
  }

  private takeOver(
    command: Extract<SessionCommand, { type: "take_over" }>,
  ): DispatchResult {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) return idempotencyResult;
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token || session.state.activeOperation) {
      return this.sessionBusy("Take Over");
    }
    const recoverableCandidateFailure =
      session.state.phase === "error" &&
      session.state.failedOperation?.type === "request_ai_answer";
    if (session.state.phase !== "active" && !recoverableCandidateFailure) {
      const reason = session.state.phase === "error" ? "session_in_error" : "session_not_active";
      return this.commitRejection(command, this.actionUnavailable("take_over", reason));
    }
    const execution = session.state.execution;
    if (!execution) {
      return this.commitRejection(
        command,
        this.actionUnavailable("take_over", "no_pending_question"),
      );
    }
    if (execution.status === "completed") {
      return this.commitRejection(
        command,
        this.actionUnavailable("take_over", "attack_chain_completed"),
      );
    }
    if (execution.status !== "awaiting_answer") {
      return this.commitRejection(
        command,
        this.actionUnavailable("take_over", "question_already_settled"),
      );
    }
    if (execution.answerMode === "a2h") {
      return this.commitRejection(
        command,
        this.actionUnavailable("take_over", "human_already_controls"),
      );
    }
    const transition = takeOverQuestionTurn(execution);
    if (transition.status === "rejected") {
      return this.commitRejection(
        command,
        this.actionUnavailable("take_over", "no_pending_question"),
      );
    }
    const nextState = sessionStateV4Schema.parse({
      ...session.state,
      phase: "active",
      execution: transition.state,
      activeOperation: null,
      failedOperation: null,
    });
    return this.commitSynchronousCommand(command, session, nextState, transition.events);
  }

  private submitHumanAnswer(
    command: Extract<SessionCommand, { type: "submit_human_answer" }>,
  ): DispatchResult {
    const idempotencyResult = this.findIdempotencyResult(command);
    if (idempotencyResult) return idempotencyResult;
    const session = this.findSessionOrReject(command);
    if ("status" in session) return session;
    if (session.row.operation_token || session.state.activeOperation) {
      return this.sessionBusy("submit a human answer");
    }
    const parsedAnswer = answerTextSchema.safeParse(command.answer);
    if (!parsedAnswer.success) {
      const reason = command.answer.trim() ? "too_long" : "empty";
      return this.commitRejection(command, {
        status: "rejected",
        error: {
          code: "invalid_human_answer",
          message: `Human answer must contain 1-${CORE_LOOP_V3_POLICY.textLimits.answer} Unicode characters`,
          details: { reason },
        },
      });
    }
    if (session.state.phase !== "active") {
      const reason = session.state.phase === "error" ? "session_in_error" : "session_not_active";
      return this.commitRejection(
        command,
        this.actionUnavailable("submit_human_answer", reason),
      );
    }
    const execution = session.state.execution;
    if (!execution) {
      return this.commitRejection(
        command,
        this.actionUnavailable("submit_human_answer", "no_pending_question"),
      );
    }
    if (execution.status === "completed") {
      return this.commitRejection(
        command,
        this.actionUnavailable("submit_human_answer", "attack_chain_completed"),
      );
    }
    const activeTurn = execution.turns.at(-1);
    if (execution.status !== "awaiting_answer" || !activeTurn) {
      return this.commitRejection(
        command,
        this.actionUnavailable("submit_human_answer", "question_already_settled"),
      );
    }
    if (execution.answerMode !== "a2h") {
      return this.commitRejection(
        command,
        this.actionUnavailable("submit_human_answer", "human_control_required"),
      );
    }
    const settled = settleQuestionTurn({
      state: execution,
      questionTurnId: activeTurn.id,
      actor: "human",
      answer: parsedAnswer.data,
      now: this.now().toISOString(),
    });
    if (settled.status === "rejected") {
      return this.commitRejection(
        command,
        this.actionUnavailable("submit_human_answer", "no_pending_question"),
      );
    }
    const chain = session.state.planRecord?.plan.attackChains[0];
    if (!chain || chain.status !== "ready") {
      return this.commitRejection(
        command,
        this.actionUnavailable("submit_human_answer", "session_not_active"),
      );
    }
    const completion = completeAtPlannedDepth({
      state: settled.state,
      chain,
      policy: session.state.policy,
      interviewLanguage: session.state.interviewLanguage,
      now: this.now().toISOString(),
    });
    const executionAfterAnswer = completion?.status === "accepted" ? completion.state : settled.state;
    const pendingEvents = [
      ...settled.events,
      ...(completion?.status === "accepted" ? completion.events : []),
    ];
    const nextState = sessionStateV4Schema.parse({
      ...session.state,
      execution: executionAfterAnswer,
      activeOperation: null,
      failedOperation: null,
    });
    return this.commitSynchronousCommand(command, session, nextState, pendingEvents);
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
        generation: emptyGeneration(CORE_LOOP_V3_POLICY.plannerContractVersion),
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
        generation: emptyGeneration(CORE_LOOP_V3_POLICY.questionContractVersion),
      };
    }
  }

  private async safeCandidateAnswer(
    input: Parameters<InterviewAgents["generateCandidateAnswer"]>[0],
  ): ReturnType<InterviewAgents["generateCandidateAnswer"]> {
    try {
      return await this.interviewAgents.generateCandidateAnswer(input);
    } catch {
      return {
        status: "failure",
        code: "agent_unexpected_error",
        message: "Unexpected InterviewAgents failure",
        retryable: false,
        generation: emptyGeneration(CORE_LOOP_V3_POLICY.candidateAnswerContractVersion),
      };
    }
  }

  private async safeTurnEvaluation(
    input: Parameters<InterviewAgents["evaluateHumanAnswer"]>[0],
  ): ReturnType<InterviewAgents["evaluateHumanAnswer"]> {
    try {
      return await this.interviewAgents.evaluateHumanAnswer(input);
    } catch {
      return {
        status: "failure",
        code: "agent_unexpected_error",
        message: "Unexpected InterviewAgents failure",
        retryable: false,
        generation: emptyGeneration(CORE_LOOP_V3_POLICY.judgeEvaluationContractVersion),
      };
    }
  }

  private async safeBenchmarks(
    input: Parameters<InterviewAgents["generateBenchmarks"]>[0],
  ): ReturnType<InterviewAgents["generateBenchmarks"]> {
    try {
      return await this.interviewAgents.generateBenchmarks(input);
    } catch {
      return {
        status: "failure",
        code: "agent_unexpected_error",
        message: "Unexpected InterviewAgents failure",
        retryable: false,
        generation: emptyGeneration(CORE_LOOP_V3_POLICY.benchmarkContractVersion),
      };
    }
  }

  private async safeCheckpointReport(
    input: Parameters<InterviewAgents["generateCheckpointReport"]>[0],
  ): ReturnType<InterviewAgents["generateCheckpointReport"]> {
    try {
      return await this.interviewAgents.generateCheckpointReport(input);
    } catch {
      return {
        status: "failure",
        code: "agent_unexpected_error",
        message: "Unexpected InterviewAgents failure",
        retryable: false,
        generation: emptyGeneration(CORE_LOOP_V3_POLICY.checkpointContractVersion),
      };
    }
  }

  private reserveOperation(
    command: Extract<SessionCommand, { type: SessionOperation }>,
    session: InternalSession,
    checkpoint?: NonNullable<SessionStateV4["checkpoint"]>,
  ): ReservedOperation | null {
    const sessionId = command.sessionId;
    const operation = command.type;
    const operationToken = this.createOperationToken();
    const timestamp = this.now();
    const nextState = sessionStateV4Schema.parse({
      ...session.state,
      activeOperation: {
        type: operation,
        token: operationToken,
        idempotencyKey: command.idempotencyKey,
        priorPhase: session.state.phase,
        startedAt: timestamp.toISOString(),
      },
      checkpoint: checkpoint ?? session.state.checkpoint,
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
    return committed ? { sessionId, operationToken, state: nextState, event } : null;
  }

  private commitPlan(
    command: Extract<SessionCommand, { type: "generate_plan" }>,
    reserved: ReservedOperation,
    record: NonNullable<SessionStateV4["planRecord"]>,
  ): DispatchResult {
    const timestamp = this.now();
    const chain = record.plan.attackChains[0];
    const nextState = sessionStateV4Schema.parse({
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
    execution: NonNullable<SessionStateV4["execution"]>,
    generation: GenerationMetadata,
  ): DispatchResult {
    const timestamp = this.now();
    const nextState = sessionStateV4Schema.parse({
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

  private commitCoreLoopOperation(
    command: Extract<
      SessionCommand,
      { type: "request_ai_answer" | "request_next_question" }
    >,
    reserved: ReservedOperation,
    execution: NonNullable<SessionStateV4["execution"]>,
    pendingEvents: Array<{ type: TimelineEvent["type"]; payload: TimelineEvent["payload"] }>,
  ): DispatchResult {
    const timestamp = this.now();
    const nextState = sessionStateV4Schema.parse({
      ...reserved.state,
      phase: "active",
      execution,
      activeOperation: null,
      failedOperation: null,
    });
    const events = this.materializePendingEvents(
      reserved.event.sequence + 1,
      pendingEvents,
      timestamp,
    );
    return this.commitSuccessfulOperation(command, reserved, nextState, events, timestamp);
  }

  private materializePendingEvents(
    firstSequence: number,
    pendingEvents: Array<{ type: TimelineEvent["type"]; payload: TimelineEvent["payload"] }>,
    timestamp: Date,
  ): TimelineEvent[] {
    return pendingEvents.map((event, index) =>
      parseTimelineEvent({
        sequence: firstSequence + index,
        type: event.type,
        payload: event.payload,
        createdAt: timestamp.toISOString(),
      }),
    );
  }

  private commitCheckpointProgress(
    reserved: ReservedOperation,
    nextState: SessionStateV4,
    event: TimelineEvent,
  ): ReservedOperation | null {
    const timestamp = this.now();
    const committed = this.database.transaction(() => {
      const update = this.database
        .prepare(
          `update sessions
           set state_json = ?, version = version + 1, updated_at = ?
           where id = ? and operation_token = ?`,
        )
        .run(
          JSON.stringify(nextState),
          timestamp.getTime(),
          reserved.sessionId,
          reserved.operationToken,
        );
      if (update.changes !== 1) return false;
      this.insertTimelineEvent(reserved.sessionId, event);
      return true;
    })();
    return committed
      ? {
          sessionId: reserved.sessionId,
          operationToken: reserved.operationToken,
          state: nextState,
          event,
        }
      : null;
  }

  private commitCheckpointSuccess(
    command: Extract<SessionCommand, { type: "generate_checkpoint" }>,
    reserved: ReservedOperation,
    nextState: SessionStateV4,
    events: TimelineEvent[],
    finalEvent: TimelineEvent,
  ): DispatchResult {
    const timestamp = this.now();
    const result = this.database.transaction((): DispatchResult | null => {
      const update = this.database
        .prepare(
          `update sessions
           set status = ?, state_json = ?, operation_token = null,
               version = version + 1, updated_at = ?
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
      this.insertTimelineEvent(command.sessionId, finalEvent);
      const applied: DispatchResult = {
        status: "applied",
        session: this.get(command.sessionId),
        events,
      };
      this.insertIdempotency(command, timestamp, applied);
      return applied;
    })();
    return result ?? this.operationConflict();
  }

  private commitSynchronousCommand(
    command: SessionCommand,
    session: InternalSession,
    nextState: SessionStateV4,
    pendingEvents: Array<{ type: TimelineEvent["type"]; payload: TimelineEvent["payload"] }>,
  ): DispatchResult {
    const timestamp = this.now();
    const events = this.materializePendingEvents(
      this.nextSequence(command.sessionId),
      pendingEvents,
      timestamp,
    );
    const result = this.database.transaction((): DispatchResult | null => {
      const update = this.database
        .prepare(
          `update sessions
           set status = ?, state_json = ?, version = version + 1, updated_at = ?
           where id = ? and version = ? and operation_token is null`,
        )
        .run(
          nextState.phase,
          JSON.stringify(nextState),
          timestamp.getTime(),
          command.sessionId,
          session.row.version,
        );
      if (update.changes !== 1) return null;
      for (const event of events) this.insertTimelineEvent(command.sessionId, event);
      const applied: DispatchResult = {
        status: "applied",
        session: this.get(command.sessionId),
        events,
      };
      this.insertIdempotency(command, timestamp, applied);
      return applied;
    })();
    return result ?? this.sessionBusy(command.type);
  }

  private commitSuccessfulOperation(
    command: Extract<
      SessionCommand,
      { type: "generate_plan" | "start" | "request_ai_answer" | "request_next_question" | "prepare_rechallenge" | "evaluate_rechallenge" | "generate_hint" }
    >,
    reserved: ReservedOperation,
    nextState: SessionStateV4,
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
    command: Extract<
      SessionCommand,
      {
        type:
          | "generate_plan"
          | "start"
          | "request_ai_answer"
          | "request_next_question"
          | "generate_checkpoint"
          | "prepare_rechallenge" | "evaluate_rechallenge" | "generate_hint";
      }
    >;
    reserved: ReservedOperation;
    stage?: CheckpointStage;
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
      stage,
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
    const nextState = sessionStateV4Schema.parse({
      ...reserved.state,
      phase: code === "budget_exhausted" ? "budget_paused" : "error",
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
        stage: stage ?? null,
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
        stage: stage ?? null,
      },
      createdAt: timestamp.toISOString(),
    });
    const result: DispatchResult = {
      status: "rejected",
      error: {
        code,
        message: userMessage,
        retryable,
        details: stage ? { ...details, stage } : details,
      },
    };
    const committed = this.database.transaction(() => {
      const update = this.database
        .prepare(
          `update sessions
           set status = ?, state_json = ?, operation_token = null,
               version = version + 1, updated_at = ?
           where id = ? and operation_token = ?`,
        )
        .run(
          nextState.phase,
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
      const checkpointStage =
        active.type === "generate_checkpoint" &&
        session.state.checkpoint &&
        session.state.checkpoint.status !== "completed"
          ? session.state.checkpoint.status
          : null;
      const nextState = sessionStateV4Schema.parse({
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
            contractVersionForOperation(session.state.policy, active.type, checkpointStage),
          ),
          stage: checkpointStage,
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
          stage: checkpointStage,
        },
        createdAt: timestamp.toISOString(),
      });
      const interruptedCommand = {
        type: active.type,
        sessionId: row.id,
        idempotencyKey: active.idempotencyKey,
      } as Extract<SessionCommand, { type: SessionOperation }>;
      const interruptedResult: DispatchResult = {
        status: "rejected",
        error: {
          code: "operation_interrupted",
          message: userMessage,
          retryable: true,
          details: checkpointStage ? { stage: checkpointStage } : undefined,
        },
      };
      this.database.transaction(() => {
        const update = this.database
          .prepare(
            `update sessions set status = 'error', state_json = ?, operation_token = null,
             version = version + 1, updated_at = ? where id = ? and operation_token = ?`,
          )
          .run(JSON.stringify(nextState), timestamp.getTime(), row.id, active.token);
        if (update.changes === 1) {
          this.insertTimelineEvent(row.id, event);
          this.insertIdempotency(interruptedCommand, timestamp, interruptedResult);
        }
      })();
    }
  }

  private findSessionOrReject(
    command: SessionCommand,
  ): InternalSession | Extract<DispatchResult, { status: "rejected" }> {
    try {
      return this.getInternal(command.sessionId);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) throw error;
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

  private actionUnavailable(
    action:
      | "request_ai_answer"
      | "request_next_question"
      | "generate_checkpoint"
      | "take_over"
      | "submit_human_answer",
    reason: ActionUnavailableReason,
  ): Extract<DispatchResult, { status: "rejected" }> {
    return {
      status: "rejected",
      error: {
        code: `${action}_not_available`,
        message: `${action} is not available: ${reason}`,
        details: { reason },
      },
    };
  }

  private sessionBusy(action: string): DispatchResult {
    return {
      status: "rejected",
      error: { code: "session_busy", message: `Cannot ${action} while another operation is active` },
    };
  }

  private operationConflict(): DispatchResult {
    return {
      status: "rejected",
      error: {
        code: "operation_conflict",
        message: "Session changed before operation commit",
      },
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
