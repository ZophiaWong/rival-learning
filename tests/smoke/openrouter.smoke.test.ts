import { describe, expect, it } from "vitest";

import {
  acceptNextQuestionCandidate,
  createAttackChainExecutionState,
} from "@/server/core-loop/attack-chain-execution";
import {
  type BenchmarkBatch,
  type InterviewLanguage,
  type QuestionTurn,
  type TurnEvaluation,
} from "@/server/core-loop/domain";
import {
  materializeBenchmarkBatchCandidate,
  materializeCheckpointReportCandidate,
  materializeTurnEvaluationCandidate,
} from "@/server/core-loop/checkpoint";
import { materializeInterviewPlanCandidate } from "@/server/core-loop/grounding";
import { createCoreLoopPolicySnapshot } from "@/server/core-loop/policy";
import {
  getProviderConfigurationStatus,
  parseServerConfig,
} from "@/server/config/server-config";
import { createInterviewAgents } from "@/server/interview-agents";
import { OpenRouterRoleRunner } from "@/server/interview-agents/role-runner/openrouter";
import type { ProviderViewContent } from "@/server/preparation-profiles";

const liveTestsEnabled = process.env.RIVAL_RUN_LIVE_TESTS === "1";

describe.skipIf(!liveTestsEnabled)("OpenRouter Step 4 live smoke", () => {
  const config = parseServerConfig({
    ...process.env,
    RIVAL_DATABASE_PATH: process.env.RIVAL_DATABASE_PATH ?? ".data/live-smoke.db",
    RIVAL_HOST: "127.0.0.1",
  });
  const interviewerStatus = getProviderConfigurationStatus(config).interviewer;
  const candidateStatus = getProviderConfigurationStatus(config).candidate;
  const judgeStatus = getProviderConfigurationStatus(config).judge;
  const agents = createInterviewAgents(new OpenRouterRoleRunner(config));
  const policy = createCoreLoopPolicySnapshot();

  function requireConfiguredInterviewer(): void {
    if (interviewerStatus.status !== "configured") {
      throw new Error(
        `interviewer provider configuration is ${interviewerStatus.status}; missing: ${interviewerStatus.missingFields.join(", ") || "none"}`,
      );
    }
  }

  function requireConfiguredCandidate(): void {
    if (candidateStatus.status !== "configured") {
      throw new Error(
        `candidate provider configuration is ${candidateStatus.status}; missing: ${candidateStatus.missingFields.join(", ") || "none"}`,
      );
    }
  }

  function requireConfiguredJudge(): void {
    if (judgeStatus.status !== "configured") {
      throw new Error(
        `judge provider configuration is ${judgeStatus.status}; missing: ${judgeStatus.missingFields.join(", ") || "none"}`,
      );
    }
  }

  async function plan(language: InterviewLanguage, providerView: ProviderViewContent) {
    let id = 0;
    const semanticRejections: string[] = [];
    for (let candidate = 1; candidate <= policy.maxSemanticCandidatesPerOperation; candidate += 1) {
      const result = await agents.planSingleAttackChain({
        operationToken: `synthetic-plan-${language}`,
        interviewLanguage: language,
        providerView,
        semanticRejections,
      });
      expect(result.status, "planning provider call failed").toBe("success");
      if (result.status !== "success") throw new Error(result.message);
      const materialized = materializeInterviewPlanCandidate({
        candidate: result.value,
        providerView,
        generation: result.generation,
        policy,
        createId: () => `synthetic-${language}-${++id}`,
        createdAt: "2026-09-04T08:00:00.000Z",
      });
      if (materialized.status === "accepted") return materialized.record;
      semanticRejections.push(materialized.reason);
    }
    throw new Error(`planning semantic candidates exhausted: ${semanticRejections.join(",")}`);
  }

  it("zh-CN produces a grounded ready plan and a valid first question", async () => {
    requireConfiguredInterviewer();
    const providerView: ProviderViewContent = {
      resume:
        "合成候选人\n主导 12 个服务的队列迁移。\n选择幂等重试令牌，将重复处理降低 35%。",
      projectNotes: "# 合成队列项目\n负责迁移范围和回滚决策。",
      jobDescription: "负责分布式后端系统的技术决策与交付。",
      targetRole: "后端工程师",
      targetLevel: "高级",
    };
    const record = await plan("zh-CN", providerView);
    const chain = record.plan.attackChains[0];
    expect(chain.status).toBe("ready");
    if (chain.status !== "ready" || !record.questionContext) return;

    const semanticRejections: string[] = [];
    const state = createAttackChainExecutionState(chain.id);
    let accepted = false;
    let requestCount = record.generation.usage.requests;
    for (let candidate = 1; candidate <= policy.maxSemanticCandidatesPerOperation; candidate += 1) {
      const result = await agents.generateNextQuestion({
        operationToken: "synthetic-question-zh-CN",
        interviewLanguage: "zh-CN",
        plan: record.plan,
        questionContext: record.questionContext,
        jobDescription: providerView.jobDescription,
        targetRole: providerView.targetRole,
        targetLevel: providerView.targetLevel,
        publicTranscript: [],
        currentDifficulty: null,
        remainingDepth: chain.estimatedDepth,
        semanticRejections,
      });
      expect(result.status, "question provider call failed").toBe("success");
      if (result.status !== "success") throw new Error(result.message);
      requestCount += result.generation.usage.requests;
      const transition = acceptNextQuestionCandidate({
        state,
        chain,
        candidate: result.value,
        generation: result.generation,
        policy,
        questionTurnId: "synthetic-turn-1",
        now: "2026-09-04T08:01:00.000Z",
      });
      if (transition.status === "accepted") {
        accepted = true;
        expect(transition.state.turns).toHaveLength(1);
        break;
      }
      semanticRejections.push(transition.reason);
    }
    console.log(
      JSON.stringify({
        scenario: "zh-CN-ready-first-question",
        provider: interviewerStatus.provider,
        model: interviewerStatus.model,
        requests: requestCount,
        planStatus: chain.status,
        firstQuestionAccepted: accepted,
      }),
    );
    expect(accepted).toBe(true);
  }, 120_000);

  it("en-US turns a deliberately vague claim into actionable needs_input", async () => {
    requireConfiguredInterviewer();
    const record = await plan("en-US", {
      resume: "Worked on software.",
      projectNotes: "",
      jobDescription: "Own complex distributed backend systems and make senior-level decisions.",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
    });
    const chain = record.plan.attackChains[0];
    console.log(
      JSON.stringify({
        scenario: "en-US-needs-input",
        provider: interviewerStatus.provider,
        model: interviewerStatus.model,
        requests: record.generation.usage.requests,
        planStatus: chain.status,
        reasonCode: chain.status === "needs_input" ? chain.reasonCode : null,
        requestedEvidenceCount:
          chain.status === "needs_input" ? chain.requestedEvidence.length : 0,
      }),
    );
    expect(chain.status).toBe("needs_input");
  }, 120_000);

  it("generates one bounded Candidate answer from synthetic evidence", async () => {
    requireConfiguredCandidate();
    const evidence = "Synthetic candidate chose idempotent retries and reduced duplicate processing by 35%.";
    const result = await agents.generateCandidateAnswer({
      operationToken: "synthetic-candidate-answer",
      interviewLanguage: "en-US",
      questionContext: {
        lines: [
          {
            source: "resume",
            lineNumber: 1,
            text: evidence,
            evidenceAnchorIds: ["synthetic-anchor-1"],
          },
        ],
        totalLines: 1,
        totalCharacters: evidence.length,
      },
      jobDescription: "Own reliable distributed backend systems.",
      targetRole: "Backend Engineer",
      targetLevel: "Senior",
      currentQuestion: "Why did you choose idempotent retries?",
      publicTranscript: [],
    });
    expect(result.status, "Candidate provider call failed").toBe("success");
    if (result.status !== "success") throw new Error(result.message);
    console.log(
      JSON.stringify({
        scenario: "en-US-candidate-answer",
        provider: candidateStatus.provider,
        model: candidateStatus.model,
        requests: result.generation.usage.requests,
        answerCharacters: Array.from(result.value.text).length,
      }),
    );
    expect(Array.from(result.value.text).length).toBeGreaterThan(0);
    expect(Array.from(result.value.text).length).toBeLessThanOrEqual(4_000);
  }, 120_000);

  it("runs Judge evaluation, Candidate Benchmark, and Judge synthesis on synthetic data", async () => {
    requireConfiguredJudge();
    requireConfiguredCandidate();
    const evidence =
      "Synthetic candidate owned an idempotent retry rollout and reduced duplicate processing by 35%.";
    const humanAnswerText =
      "I would monitor duplicate rate and roll back if it increased.";
    const questionContext = {
      lines: [
        {
          source: "resume" as const,
          lineNumber: 1,
          text: evidence,
          evidenceAnchorIds: ["synthetic-anchor-1"],
        },
      ],
      totalLines: 1,
      totalCharacters: evidence.length,
    };
    const humanTurn: QuestionTurn = {
      id: "synthetic-human-turn-1",
      ordinal: 1,
      status: "settled",
      question: {
        text: "How would you validate the retry rollout?",
        difficulty: "target",
        evidenceAnchorIds: ["synthetic-anchor-1"],
      },
      normalizationKey: "how would you validate the retry rollout",
      createdAt: "2026-09-06T08:00:00.000Z",
      settledAt: "2026-09-06T08:01:00.000Z",
      answer: {
        actor: "human",
        text: humanAnswerText,
      },
      generation: {
        contractVersion: "interviewer-question-v1",
        provider: "synthetic",
        model: "synthetic",
        usage: { requests: 0, inputTokens: 0, outputTokens: 0, usageComplete: true },
      },
    };

    let evaluation: TurnEvaluation | null = null;
    const evaluationRejections: string[] = [];
    for (let candidate = 1; candidate <= policy.maxSemanticCandidatesPerOperation; candidate += 1) {
      const result = await agents.evaluateHumanAnswer({
        operationToken: "synthetic-evaluation",
        interviewLanguage: "en-US",
        rubricVersion: "answer-rubric-v1",
        questionContext,
        jobDescription: "Own reliable distributed backend systems.",
        targetRole: "Backend Engineer",
        targetLevel: "Senior",
        knowledgeTarget: "Verify decision depth and measurable validation.",
        currentTurn: {
          id: humanTurn.id,
          question: humanTurn.question.text,
          answer: humanAnswerText,
        },
        priorPublicTranscript: [],
        semanticRejections: evaluationRejections,
      });
      expect(result.status, "Judge evaluation provider call failed").toBe("success");
      if (result.status !== "success") throw new Error(result.message);
      const materialized = materializeTurnEvaluationCandidate({
        turn: humanTurn,
        candidate: result.value,
        generation: result.generation,
        rubricVersion: "answer-rubric-v1",
        createdAt: "2026-09-06T08:02:00.000Z",
      });
      if (materialized.status === "accepted") {
        evaluation = materialized.evaluation;
        break;
      }
      evaluationRejections.push(materialized.reason);
    }
    expect(evaluation, `evaluation rejections: ${evaluationRejections.join(",")}`).not.toBeNull();
    if (!evaluation) return;

    let benchmarkBatch: BenchmarkBatch | null = null;
    const benchmarkRejections: string[] = [];
    for (let candidate = 1; candidate <= policy.maxSemanticCandidatesPerOperation; candidate += 1) {
      const result = await agents.generateBenchmarks({
        operationToken: "synthetic-benchmark",
        interviewLanguage: "en-US",
        questionContext,
        jobDescription: "Own reliable distributed backend systems.",
        targetRole: "Backend Engineer",
        targetLevel: "Senior",
        knowledgeTarget: "Verify decision depth and measurable validation.",
        humanQuestions: [
          {
            turnId: humanTurn.id,
            question: humanTurn.question.text,
            evidenceAnchorIds: humanTurn.question.evidenceAnchorIds,
          },
        ],
        semanticRejections: benchmarkRejections,
      });
      expect(result.status, "Candidate Benchmark provider call failed").toBe("success");
      if (result.status !== "success") throw new Error(result.message);
      const materialized = materializeBenchmarkBatchCandidate({
        humanTurns: [humanTurn],
        candidate: result.value,
        generation: result.generation,
        createdAt: "2026-09-06T08:03:00.000Z",
      });
      if (materialized.status === "accepted") {
        benchmarkBatch = materialized.batch;
        break;
      }
      benchmarkRejections.push(materialized.reason);
    }
    expect(benchmarkBatch, `benchmark rejections: ${benchmarkRejections.join(",")}`).not.toBeNull();
    if (!benchmarkBatch) return;

    const checkpointRejections: string[] = [];
    let checkpointAccepted = false;
    for (let candidate = 1; candidate <= policy.maxSemanticCandidatesPerOperation; candidate += 1) {
      const result = await agents.generateCheckpointReport({
        operationToken: "synthetic-checkpoint",
        interviewLanguage: "en-US",
        questionContext,
        jobDescription: "Own reliable distributed backend systems.",
        targetRole: "Backend Engineer",
        targetLevel: "Senior",
        knowledgeTarget: "Verify decision depth and measurable validation.",
        humanTurns: [
          {
            turnId: humanTurn.id,
            question: humanTurn.question.text,
            answer: humanAnswerText,
          },
        ],
        evaluations: [{ turnId: evaluation.turnId, dimensions: evaluation.dimensions }],
        benchmarks: benchmarkBatch.benchmarks,
        publicTranscript: [
          { question: humanTurn.question.text, answer: humanTurn.answer },
        ],
        semanticRejections: checkpointRejections,
      });
      expect(result.status, "Judge synthesis provider call failed").toBe("success");
      if (result.status !== "success") throw new Error(result.message);
      const materialized = materializeCheckpointReportCandidate({
        chainId: "synthetic-chain-1",
        humanTurns: [humanTurn],
        evaluations: [evaluation],
        benchmarkBatch,
        candidate: result.value,
        generation: result.generation,
        createId: () => "synthetic-finding-1",
        completedAt: "2026-09-06T08:04:00.000Z",
      });
      if (materialized.status === "accepted") {
        checkpointAccepted = true;
        break;
      }
      checkpointRejections.push(materialized.reason);
    }
    console.log(
      JSON.stringify({
        scenario: "rubric-first-checkpoint",
        judgeModel: judgeStatus.model,
        candidateModel: candidateStatus.model,
        evaluationRejections,
        benchmarkRejections,
        checkpointRejections,
        checkpointAccepted,
      }),
    );
    expect(checkpointAccepted).toBe(true);
  }, 180_000);
  it("Step 5 learning operations accept synthetic input", async () => {
    requireConfiguredInterviewer();
    requireConfiguredJudge();
    const common = { interviewLanguage: "en-US" as const, targetRole: "Backend Engineer", targetLevel: "Senior",
      targetDimension: "evidence_and_outcome" as const };
    const evidence = "Synthetic candidate owned a queue migration.";
    const prepared = await agents.prepareRechallenge({ ...common, findingSummary: "Validate decisions with measurable outcomes.",
      originalQuestions: ["How did you validate your queue migration?"],
      evidenceContext: { lines: [{ source: "resume", lineNumber: 1, text: evidence, evidenceAnchorIds: ["synthetic-1"] }], totalLines: 1, totalCharacters: evidence.length },
    });
    expect(prepared.status).toBe("success");
    if (prepared.status !== "success") return;
    expect(prepared.value.targetDimension).toBe(common.targetDimension);
    const question = prepared.value.question;
    const answer = "I would compare failure rate and p95 latency against the pre-rollout baseline using equivalent traffic over fixed windows, define rollback thresholds in advance, and report the observed before/after change.";
    const evaluated = await agents.evaluateRechallenge({ ...common, question, answer });
    expect(evaluated.status).toBe("success");
    if (evaluated.status !== "success") return;
    expect(evaluated.value.answerExcerpts.every(excerpt => answer.includes(excerpt))).toBe(true);
    const hinted = await agents.generateHint({ ...common, question });
    expect(hinted.status).toBe("success");
    console.info(JSON.stringify({ operation: "learning_smoke", preparation: prepared.generation,
      evaluation: evaluated.generation, hint: hinted.generation }));
  }, 300_000);

});
