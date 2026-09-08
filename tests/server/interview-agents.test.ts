import { describe, expect, it } from "vitest";

import { createInterviewAgents } from "@/server/interview-agents";
import { RUBRIC_DIMENSIONS, type InterviewPlan } from "@/server/core-loop/domain";
import type { RoleRunRequest } from "@/server/interview-agents/role-runner";
import { ScriptedRoleRunner } from "@/server/interview-agents/role-runner/scripted";
import { scriptedRoleRunnerEnabled } from "@/server/interview-agents/runtime";

const providerView = {
  resume: "Owned a queue migration and reduced failures by 35%.",
  projectNotes: "# Queue\nSelected idempotent retries.",
  jobDescription: "Own distributed backend systems.",
  targetRole: "Backend Engineer",
  targetLevel: "Senior",
};

describe("InterviewAgents Interface", () => {
  it("allows the scripted Adapter only behind a non-production test switch", () => {
    expect(
      scriptedRoleRunnerEnabled({
        NODE_ENV: "test",
        RIVAL_TEST_SCRIPTED_ROLE_RUNNER: "1",
      }),
    ).toBe(true);
    expect(() =>
      scriptedRoleRunnerEnabled({
        NODE_ENV: "production",
        RIVAL_TEST_SCRIPTED_ROLE_RUNNER: "1",
      }),
    ).toThrow(/forbidden in production/);
    expect(scriptedRoleRunnerEnabled({ NODE_ENV: "test" })).toBe(false);
  });

  it("uses the same structured planning logic with a Scripted RoleRunner", async () => {
    let captured: RoleRunRequest<unknown> | undefined;
    const agents = createInterviewAgents(
      new ScriptedRoleRunner([
        (request) => {
          captured = request;
          return {
            status: "success",
            value: {
              outcome: {
                status: "ready",
                intent: "ownership_claim_depth",
                knowledgeTarget: "确认候选人的责任范围与关键决策。",
                evidenceAnchors: [{ source: "resume", startLine: 1, endLine: 1 }],
                initialDifficulty: "target",
                difficultyBasis: {
                  signals: ["quantified_outcome"],
                  explanation: "资料中包含量化结果。",
                },
                estimatedDepth: 3,
              },
            },
          };
        },
      ]),
    );

    const result = await agents.planSingleAttackChain({
      operationToken: "operation-1",
      interviewLanguage: "zh-CN",
      providerView,
      semanticRejections: [],
    });

    expect(result).toMatchObject({
      status: "success",
      value: { status: "ready", intent: "ownership_claim_depth" },
      generation: { contractVersion: "interview-plan-v1" },
    });
    expect(captured).toMatchObject({
      role: "interviewer",
      operation: "plan_single_attack_chain",
    });
    expect(captured?.onOutputDelta).toBeUndefined();
    expect(JSON.parse(captured!.input)).toEqual({
      interviewLanguage: "zh-CN",
      providerView,
      semanticRejections: [],
    });
    expect(captured!.input).not.toContain("operation-1");
  });

  it("supports an actionable English needs_input result without fake ready fields", async () => {
    const agents = createInterviewAgents(
      new ScriptedRoleRunner([
        {
          status: "success",
          value: {
            outcome: {
              status: "needs_input",
              intent: "ownership_claim_depth",
              reasonCode: "claim_too_vague",
              requestedEvidence: [
                { kind: "decision", prompt: "Add one decision you personally made." },
              ],
            },
          },
        },
      ]),
    );
    await expect(
      agents.planSingleAttackChain({
        operationToken: "operation-1",
        interviewLanguage: "en-US",
        providerView: { ...providerView, resume: "Worked on queues." },
        semanticRejections: [],
      }),
    ).resolves.toMatchObject({
      status: "success",
      value: {
        status: "needs_input",
        reasonCode: "claim_too_vague",
        requestedEvidence: [{ kind: "decision" }],
      },
    });
  });

  it("sends question generation only the persisted anchor context and hiring bar", async () => {
    let captured: RoleRunRequest<unknown> | undefined;
    const agents = createInterviewAgents(
      new ScriptedRoleRunner([
        (request) => {
          captured = request;
          return {
            status: "success",
            value: {
              outcome: {
                status: "ask",
                question: {
                  text: "What decision did you personally make?",
                  difficulty: "target",
                  evidenceAnchorIds: ["anchor-1"],
                },
              },
            },
          };
        },
      ]),
    );
    const plan: InterviewPlan = {
      id: "plan-1",
      policyVersion: "attack-chain-v1",
      createdAt: "2026-09-04T08:00:00.000Z",
      attackChains: [
        {
          id: "chain-1",
          status: "ready",
          intent: "ownership_claim_depth",
          knowledgeTarget: "Verify ownership",
          evidenceAnchors: [
            {
              id: "anchor-1",
              source: "resume",
              startLine: 1,
              endLine: 1,
              excerpt: providerView.resume,
            },
          ],
          initialDifficulty: "target",
          difficultyBasis: {
            signals: ["quantified_outcome"],
            explanation: "The claim has an outcome.",
          },
          estimatedDepth: 3,
        },
      ],
    };
    await agents.generateNextQuestion({
      operationToken: "operation-2",
      interviewLanguage: "en-US",
      plan,
      questionContext: {
        lines: [
          {
            source: "resume",
            lineNumber: 1,
            text: providerView.resume,
            evidenceAnchorIds: ["anchor-1"],
          },
        ],
        totalLines: 1,
        totalCharacters: providerView.resume.length,
      },
      jobDescription: providerView.jobDescription,
      targetRole: providerView.targetRole,
      targetLevel: providerView.targetLevel,
      publicTranscript: [
        {
          question: "What scope did you own?",
          answer: { actor: "candidate", text: "I owned the migration boundary." },
        },
      ],
      currentDifficulty: null,
      remainingDepth: 3,
      semanticRejections: [],
    });

    const payload = JSON.parse(captured!.input) as Record<string, unknown>;
    expect(payload).toHaveProperty("evidenceContext");
    expect(payload).toHaveProperty("hiringBar");
    expect(payload).toHaveProperty("publicTranscript", [
      {
        question: "What scope did you own?",
        answer: { actor: "candidate", text: "I owned the migration boundary." },
      },
    ]);
    expect(payload).not.toHaveProperty("providerView");
    expect(captured!.input).not.toContain(providerView.projectNotes);
    expect(captured?.onOutputDelta).toBeUndefined();
  });

  it("assembles a bounded Candidate payload with an independent role and contract", async () => {
    let captured: RoleRunRequest<unknown> | undefined;
    const agents = createInterviewAgents(
      new ScriptedRoleRunner([
        (request) => {
          captured = request;
          return {
            status: "success",
            value: {
              outcome: {
                text: "I chose idempotent retries; the supplied evidence does not establish the wider team split.",
              },
            },
          };
        },
      ]),
    );
    const result = await agents.generateCandidateAnswer({
      operationToken: "OPERATION_TOKEN_CANARY",
      interviewLanguage: "en-US",
      questionContext: {
        lines: [
          {
            source: "resume",
            lineNumber: 1,
            text: providerView.resume,
            evidenceAnchorIds: ["anchor-1"],
          },
        ],
        totalLines: 1,
        totalCharacters: providerView.resume.length,
      },
      jobDescription: providerView.jobDescription,
      targetRole: providerView.targetRole,
      targetLevel: providerView.targetLevel,
      currentQuestion: "Why did you choose idempotent retries?",
      publicTranscript: [
        {
          question: "What did you own?",
          answer: { actor: "candidate", text: "I owned the migration." },
        },
      ],
      providerView: "FULL_PROVIDER_VIEW_CANARY",
      profileSnapshot: "RAW_PROFILE_CANARY",
      interviewPlan: "HIDDEN_PLAN_CANARY",
      judgeData: "JUDGE_CANARY",
      repoTools: "REPO_CAPABILITY_CANARY",
    } as Parameters<typeof agents.generateCandidateAnswer>[0] & Record<string, unknown>);

    expect(result).toMatchObject({
      status: "success",
      generation: { contractVersion: "candidate-answer-v1" },
    });
    expect(captured).toMatchObject({
      role: "candidate",
      operation: "generate_candidate_answer",
    });
    expect(captured?.onOutputDelta).toBeUndefined();
    const payload = JSON.parse(captured!.input) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "currentQuestion",
      "evidenceContext",
      "hiringBar",
      "interviewLanguage",
      "publicTranscript",
    ]);
    for (const canary of [
      "OPERATION_TOKEN_CANARY",
      "FULL_PROVIDER_VIEW_CANARY",
      "RAW_PROFILE_CANARY",
      "HIDDEN_PLAN_CANARY",
      "JUDGE_CANARY",
      "REPO_CAPABILITY_CANARY",
    ]) {
      expect(captured!.input).not.toContain(canary);
    }
  });

  it("rejects Candidate output beyond the 4000 Unicode-character contract", async () => {
    const agents = createInterviewAgents(
      new ScriptedRoleRunner([
        {
          status: "success",
          value: { outcome: { text: "🙂".repeat(4_001) } },
        },
      ]),
    );

    await expect(
      agents.generateCandidateAnswer({
        operationToken: "operation-3",
        interviewLanguage: "en-US",
        questionContext: {
          lines: [
            {
              source: "resume",
              lineNumber: 1,
              text: providerView.resume,
              evidenceAnchorIds: ["anchor-1"],
            },
          ],
          totalLines: 1,
          totalCharacters: providerView.resume.length,
        },
        jobDescription: providerView.jobDescription,
        targetRole: providerView.targetRole,
        targetLevel: providerView.targetLevel,
        currentQuestion: "What did you decide?",
        publicTranscript: [],
      }),
    ).resolves.toMatchObject({ status: "failure", code: "schema_invalid" });
  });

  it("evaluates one human answer with a fixed rubric and no Benchmark visibility", async () => {
    let captured: RoleRunRequest<unknown> | undefined;
    const agents = createInterviewAgents(
      new ScriptedRoleRunner([
        (request) => {
          captured = request;
          return {
            status: "success",
            value: {
              outcome: {
                dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
                  dimension,
                  verdict: dimension === "evidence_and_outcome" ? "partial" : "met",
                  rationale: "The answer addresses the requested dimension.",
                  answerExcerpts: ["idempotent retries"],
                })),
              },
            },
          };
        },
      ]),
    );

    const result = await agents.evaluateHumanAnswer({
      operationToken: "OPERATION_TOKEN_CANARY",
      interviewLanguage: "en-US",
      rubricVersion: "answer-rubric-v1",
      questionContext: {
        lines: [
          {
            source: "resume",
            lineNumber: 1,
            text: providerView.resume,
            evidenceAnchorIds: ["anchor-1"],
          },
        ],
        totalLines: 1,
        totalCharacters: providerView.resume.length,
      },
      jobDescription: providerView.jobDescription,
      targetRole: providerView.targetRole,
      targetLevel: providerView.targetLevel,
      knowledgeTarget: "Verify ownership and decision depth",
      currentTurn: {
        id: "turn-2",
        question: "Why did you choose idempotent retries?",
        answer: "I chose idempotent retries to control duplicate processing risk.",
      },
      priorPublicTranscript: [],
      semanticRejections: [],
      benchmark: "BENCHMARK_CANARY",
      providerView: "FULL_PROVIDER_VIEW_CANARY",
      profileSnapshot: "RAW_PROFILE_CANARY",
      interviewPlan: "HIDDEN_PLAN_CANARY",
      candidateGeneration: "CANDIDATE_GENERATION_CANARY",
      repoTools: "REPO_CAPABILITY_CANARY",
    } as Parameters<typeof agents.evaluateHumanAnswer>[0] & Record<string, unknown>);

    expect(result).toMatchObject({
      status: "success",
      generation: { contractVersion: "judge-turn-evaluation-v1" },
    });
    expect(captured).toMatchObject({ role: "judge", operation: "evaluate_human_answer" });
    expect(captured?.onOutputDelta).toBeUndefined();
    const payload = JSON.parse(captured!.input) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "currentTurn",
      "evidenceContext",
      "hiringBar",
      "interviewLanguage",
      "knowledgeTarget",
      "priorPublicTranscript",
      "rubric",
      "semanticRejections",
    ]);
    expect(payload).toHaveProperty("rubric.version", "answer-rubric-v1");
    expect(payload).toHaveProperty("rubric.dimensions", RUBRIC_DIMENSIONS);
    for (const canary of [
      "OPERATION_TOKEN_CANARY",
      "BENCHMARK_CANARY",
      "FULL_PROVIDER_VIEW_CANARY",
      "RAW_PROFILE_CANARY",
      "HIDDEN_PLAN_CANARY",
      "CANDIDATE_GENERATION_CANARY",
      "REPO_CAPABILITY_CANARY",
    ]) {
      expect(captured!.input).not.toContain(canary);
    }
  });

  it("generates a Candidate Benchmark batch without human answers or Judge data", async () => {
    let captured: RoleRunRequest<unknown> | undefined;
    const agents = createInterviewAgents(
      new ScriptedRoleRunner([
        (request) => {
          captured = request;
          return {
            status: "success",
            value: {
              outcome: {
                benchmarks: [
                  {
                    turnId: "turn-2",
                    text: "I would validate duplicate-rate and latency signals.",
                    evidenceAnchorIds: ["anchor-1"],
                  },
                ],
              },
            },
          };
        },
      ]),
    );

    const result = await agents.generateBenchmarks({
      operationToken: "OPERATION_TOKEN_CANARY",
      interviewLanguage: "en-US",
      questionContext: {
        lines: [
          {
            source: "resume",
            lineNumber: 1,
            text: providerView.resume,
            evidenceAnchorIds: ["anchor-1"],
          },
        ],
        totalLines: 1,
        totalCharacters: providerView.resume.length,
      },
      jobDescription: providerView.jobDescription,
      targetRole: providerView.targetRole,
      targetLevel: providerView.targetLevel,
      knowledgeTarget: "Verify ownership and decision depth",
      humanQuestions: [
        {
          turnId: "turn-2",
          question: "Why did you choose idempotent retries?",
          evidenceAnchorIds: ["anchor-1"],
        },
      ],
      semanticRejections: [],
      humanAnswer: "HUMAN_ANSWER_CANARY",
      judgeEvaluation: "JUDGE_EVALUATION_CANARY",
      publicTranscript: "TRANSCRIPT_CANARY",
      providerView: "FULL_PROVIDER_VIEW_CANARY",
      profileSnapshot: "RAW_PROFILE_CANARY",
      interviewPlan: "HIDDEN_PLAN_CANARY",
      repoTools: "REPO_CAPABILITY_CANARY",
    } as Parameters<typeof agents.generateBenchmarks>[0] & Record<string, unknown>);

    expect(result).toMatchObject({
      status: "success",
      generation: { contractVersion: "candidate-benchmark-v1" },
    });
    expect(captured).toMatchObject({ role: "candidate", operation: "generate_benchmark_batch" });
    const payload = JSON.parse(captured!.input) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "evidenceContext",
      "hiringBar",
      "humanQuestions",
      "interviewLanguage",
      "knowledgeTarget",
      "semanticRejections",
    ]);
    for (const canary of [
      "OPERATION_TOKEN_CANARY",
      "HUMAN_ANSWER_CANARY",
      "JUDGE_EVALUATION_CANARY",
      "TRANSCRIPT_CANARY",
      "FULL_PROVIDER_VIEW_CANARY",
      "RAW_PROFILE_CANARY",
      "HIDDEN_PLAN_CANARY",
      "REPO_CAPABILITY_CANARY",
    ]) {
      expect(captured!.input).not.toContain(canary);
    }
  });

  it("synthesizes differences from frozen evaluations and Benchmarks through Judge", async () => {
    let captured: RoleRunRequest<unknown> | undefined;
    const agents = createInterviewAgents(
      new ScriptedRoleRunner([
        (request) => {
          captured = request;
          return {
            status: "success",
            value: {
              outcome: {
                comparisons: [
                  {
                    turnId: "turn-2",
                    differences: [
                      {
                        dimension: "evidence_and_outcome",
                        explanation: "The answer omits validation signals.",
                        answerExcerpt: "idempotent retries",
                        benchmarkExcerpt: "duplicate-rate and latency signals",
                      },
                    ],
                  },
                ],
                findings: [
                  {
                    targetDimension: "evidence_and_outcome",
                    summary: "Connect decisions to observable outcomes.",
                    basis: "The answer does not identify validation signals.",
                    sourceTurnIds: ["turn-2"],
                  },
                ],
              },
            },
          };
        },
      ]),
    );
    const dimensions = RUBRIC_DIMENSIONS.map((dimension) => ({
      dimension,
      verdict: dimension === "evidence_and_outcome" ? "partial" : "met",
      rationale: "Frozen rubric result.",
      answerExcerpts: ["idempotent retries"],
    }));

    const result = await agents.generateCheckpointReport({
      operationToken: "OPERATION_TOKEN_CANARY",
      interviewLanguage: "en-US",
      questionContext: {
        lines: [
          {
            source: "resume",
            lineNumber: 1,
            text: providerView.resume,
            evidenceAnchorIds: ["anchor-1"],
          },
        ],
        totalLines: 1,
        totalCharacters: providerView.resume.length,
      },
      jobDescription: providerView.jobDescription,
      targetRole: providerView.targetRole,
      targetLevel: providerView.targetLevel,
      knowledgeTarget: "Verify ownership and decision depth",
      humanTurns: [
        {
          turnId: "turn-2",
          question: "Why did you choose idempotent retries?",
          answer: "I chose idempotent retries to control duplicate processing risk.",
        },
      ],
      evaluations: [{ turnId: "turn-2", dimensions }],
      benchmarks: [
        {
          turnId: "turn-2",
          text: "I would validate duplicate-rate and latency signals.",
          evidenceAnchorIds: ["anchor-1"],
        },
      ],
      publicTranscript: [],
      semanticRejections: [],
      evaluationGeneration: "EVALUATION_GENERATION_CANARY",
      benchmarkGeneration: "BENCHMARK_GENERATION_CANARY",
      providerView: "FULL_PROVIDER_VIEW_CANARY",
      profileSnapshot: "RAW_PROFILE_CANARY",
      interviewPlan: "HIDDEN_PLAN_CANARY",
      repoTools: "REPO_CAPABILITY_CANARY",
    } as unknown as Parameters<typeof agents.generateCheckpointReport>[0] & Record<string, unknown>);

    expect(result).toMatchObject({
      status: "success",
      generation: { contractVersion: "judge-checkpoint-v1" },
    });
    expect(captured).toMatchObject({ role: "judge", operation: "generate_checkpoint_report" });
    const payload = JSON.parse(captured!.input) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "benchmarks",
      "evaluations",
      "evidenceContext",
      "hiringBar",
      "humanTurns",
      "interviewLanguage",
      "knowledgeTarget",
      "publicTranscript",
      "semanticRejections",
    ]);
    for (const canary of [
      "OPERATION_TOKEN_CANARY",
      "EVALUATION_GENERATION_CANARY",
      "BENCHMARK_GENERATION_CANARY",
      "FULL_PROVIDER_VIEW_CANARY",
      "RAW_PROFILE_CANARY",
      "HIDDEN_PLAN_CANARY",
      "REPO_CAPABILITY_CANARY",
    ]) {
      expect(captured!.input).not.toContain(canary);
    }
  });
});
