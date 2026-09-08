import { describe, expect, it } from "vitest";

import {
  benchmarkCandidateSchema,
  benchmarkBatchCandidateSchema,
  checkpointReportCandidateSchema,
  gapFindingCandidateSchema,
  RUBRIC_DIMENSIONS,
  turnDifferenceCandidateSchema,
  turnEvaluationCandidateSchema,
  type GenerationMetadata,
  type QuestionTurn,
  type TurnEvaluation,
} from "@/server/core-loop/domain";
import {
  materializeBenchmarkBatchCandidate,
  materializeCheckpointReportCandidate,
  materializeTurnEvaluationCandidate,
} from "@/server/core-loop/checkpoint";
import {
  CORE_LOOP_V3_POLICY,
  coreLoopPolicySchema,
} from "@/server/core-loop/policy";
import {
  projectSessionState,
  sessionStateV4Schema,
} from "@/server/session-engine/state";

describe("Checkpoint domain contracts", () => {
  const judgeGeneration: GenerationMetadata = {
    contractVersion: "judge-turn-evaluation-v1",
    provider: "openrouter",
    model: "synthetic/judge",
    usage: { requests: 1, inputTokens: 20, outputTokens: 10, usageComplete: true },
  };

  const benchmarkGeneration: GenerationMetadata = {
    ...judgeGeneration,
    contractVersion: "candidate-benchmark-v1",
    model: "synthetic/candidate",
  };

  const checkpointGeneration: GenerationMetadata = {
    ...judgeGeneration,
    contractVersion: "judge-checkpoint-v1",
  };

  const humanTurn: QuestionTurn = {
    id: "turn-2",
    ordinal: 2,
    status: "settled",
    question: {
      text: "Why did you choose idempotent retries?",
      difficulty: "target",
      evidenceAnchorIds: ["anchor-1"],
    },
    normalizationKey: "why did you choose idempotent retries",
    createdAt: "2026-09-06T08:00:00.000Z",
    settledAt: "2026-09-06T08:01:00.000Z",
    answer: {
      actor: "human",
      text: "I chose idempotent retries to control duplicate processing risk.",
    },
    generation: {
      ...judgeGeneration,
      contractVersion: "interviewer-question-v1",
      model: "synthetic/interviewer",
    },
  };

  it("fixes the rubric dimensions, verdicts, contracts, and text limits", () => {
    expect(RUBRIC_DIMENSIONS).toEqual([
      "answer_relevance",
      "ownership_scope",
      "decision_reasoning",
      "evidence_and_outcome",
      "target_level_depth",
    ]);
    expect(coreLoopPolicySchema.parse(CORE_LOOP_V3_POLICY)).toMatchObject({
      version: "core-loop-v3",
      judgeEvaluationContractVersion: "judge-turn-evaluation-v1",
      benchmarkContractVersion: "candidate-benchmark-v1",
      checkpointContractVersion: "judge-checkpoint-v1",
      rubricVersion: "answer-rubric-v1",
      textLimits: {
        answer: 4_000,
        benchmark: 4_000,
        checkpointRationale: 600,
        findingSummary: 240,
        evidenceExcerpt: 400,
      },
    });

    expect(
      turnEvaluationCandidateSchema.parse({
        dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict: "met",
          rationale: "The answer covers the requested dimension.",
          answerExcerpts: ["I owned the migration."],
        })),
      }).dimensions,
    ).toHaveLength(5);

    expect(
      checkpointReportCandidateSchema.safeParse({
        comparisons: [],
        findings: [],
      }).success,
    ).toBe(true);
    expect(
      checkpointReportCandidateSchema.safeParse({
        comparisons: [],
        findings: Array.from({ length: 4 }, (_, index) => ({
          targetDimension: RUBRIC_DIMENSIONS[index],
          summary: `Finding ${index}`,
          basis: "A grounded difference.",
          sourceTurnIds: [`turn-${index}`],
        })),
      }).success,
    ).toBe(false);

    expect(
      benchmarkCandidateSchema.safeParse({
        turnId: "turn-1",
        text: "🙂".repeat(4_000),
        evidenceAnchorIds: ["anchor-1"],
      }).success,
    ).toBe(true);
    expect(
      benchmarkCandidateSchema.safeParse({
        turnId: "turn-1",
        text: "🙂".repeat(4_001),
        evidenceAnchorIds: ["anchor-1"],
      }).success,
    ).toBe(false);
    expect(
      gapFindingCandidateSchema.safeParse({
        targetDimension: "answer_relevance",
        summary: "🙂".repeat(240),
        basis: "🙂".repeat(600),
        sourceTurnIds: ["turn-1"],
      }).success,
    ).toBe(true);
    expect(
      gapFindingCandidateSchema.safeParse({
        targetDimension: "answer_relevance",
        summary: "🙂".repeat(241),
        basis: "valid",
        sourceTurnIds: ["turn-1"],
      }).success,
    ).toBe(false);
    expect(
      turnDifferenceCandidateSchema.safeParse({
        dimension: "answer_relevance",
        explanation: "valid",
        answerExcerpt: "🙂".repeat(401),
        benchmarkExcerpt: "valid",
      }).success,
    ).toBe(false);
    expect(
      turnEvaluationCandidateSchema.safeParse({
        dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict: "met",
          rationale: "valid",
          answerExcerpts: [],
        })),
        score: 5,
      }).success,
    ).toBe(false);
  });

  it("materializes only evaluation evidence copied exactly from the human answer", () => {
    const candidate = turnEvaluationCandidateSchema.parse({
      dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
        dimension,
        verdict: dimension === "evidence_and_outcome" ? "partial" : "met",
        rationale: "The response provides a relevant reason.",
        answerExcerpts: ["idempotent retries"],
      })),
    });

    const accepted = materializeTurnEvaluationCandidate({
      turn: humanTurn,
      candidate,
      generation: judgeGeneration,
      rubricVersion: "answer-rubric-v1",
      createdAt: "2026-09-06T08:02:00.000Z",
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      evaluation: {
        turnId: "turn-2",
        rubricVersion: "answer-rubric-v1",
        generation: { contractVersion: "judge-turn-evaluation-v1" },
      },
    });
    if (accepted.status !== "accepted") throw new Error("evaluation was rejected");
    expect(accepted.evaluation.dimensions[0]).toMatchObject({
      dimension: "answer_relevance",
    });

    const invalid = structuredClone(candidate);
    invalid.dimensions[0].answerExcerpts = ["a claim the user never made"];
    expect(
      materializeTurnEvaluationCandidate({
        turn: humanTurn,
        candidate: invalid,
        generation: judgeGeneration,
        rubricVersion: "answer-rubric-v1",
        createdAt: "2026-09-06T08:02:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "evaluation_excerpt_not_found" });
  });

  it("accepts a Benchmark batch only when turn order and evidence anchors match", () => {
    const candidate = benchmarkBatchCandidateSchema.parse({
      benchmarks: [
        {
          turnId: "turn-2",
          text: "I would use idempotent retries and validate duplicate-rate and latency signals.",
          evidenceAnchorIds: ["anchor-1"],
        },
      ],
    });
    expect(
      materializeBenchmarkBatchCandidate({
        humanTurns: [humanTurn],
        candidate,
        generation: benchmarkGeneration,
        createdAt: "2026-09-06T08:03:00.000Z",
      }),
    ).toMatchObject({
      status: "accepted",
      batch: {
        benchmarks: [{ turnId: "turn-2" }],
        generation: { contractVersion: "candidate-benchmark-v1" },
      },
    });

    expect(
      materializeBenchmarkBatchCandidate({
        humanTurns: [humanTurn],
        candidate: {
          benchmarks: [{ ...candidate.benchmarks[0], turnId: "turn-3" }],
        },
        generation: benchmarkGeneration,
        createdAt: "2026-09-06T08:03:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "benchmark_turn_mismatch" });
    expect(
      materializeBenchmarkBatchCandidate({
        humanTurns: [humanTurn],
        candidate: {
          benchmarks: [{ ...candidate.benchmarks[0], evidenceAnchorIds: ["anchor-hidden"] }],
        },
        generation: benchmarkGeneration,
        createdAt: "2026-09-06T08:03:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "benchmark_evidence_mismatch" });
    expect(
      materializeBenchmarkBatchCandidate({
        humanTurns: [humanTurn],
        candidate: {
          benchmarks: [
            { ...candidate.benchmarks[0], evidenceAnchorIds: ["anchor-1", "anchor-1"] },
          ],
        },
        generation: benchmarkGeneration,
        createdAt: "2026-09-06T08:03:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "benchmark_evidence_mismatch" });
  });

  it("binds every difference and unique finding to frozen rubric and exact text", () => {
    const evaluation: TurnEvaluation = {
      turnId: "turn-2",
      rubricVersion: "answer-rubric-v1",
      dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
        dimension,
        verdict: dimension === "evidence_and_outcome" ? "partial" : "met",
        rationale: "Grounded rubric rationale.",
        answerExcerpts: ["idempotent retries"],
      })) as TurnEvaluation["dimensions"],
      generation: judgeGeneration,
      createdAt: "2026-09-06T08:02:00.000Z",
    };
    const benchmarkBatch = materializeBenchmarkBatchCandidate({
      humanTurns: [humanTurn],
      candidate: {
        benchmarks: [
          {
            turnId: "turn-2",
            text: "I would validate duplicate-rate and latency signals before expanding rollout.",
            evidenceAnchorIds: ["anchor-1"],
          },
        ],
      },
      generation: benchmarkGeneration,
      createdAt: "2026-09-06T08:03:00.000Z",
    });
    if (benchmarkBatch.status !== "accepted") throw new Error("benchmark was rejected");

    const candidate = checkpointReportCandidateSchema.parse({
      comparisons: [
        {
          turnId: "turn-2",
          differences: [
            {
              dimension: "evidence_and_outcome",
              explanation: "The answer names the mechanism but not the validation signals.",
              answerExcerpt: "idempotent retries",
              benchmarkExcerpt: "duplicate-rate and latency signals",
            },
          ],
        },
      ],
      findings: [
        {
          targetDimension: "evidence_and_outcome",
          summary: "Tie the decision to observable outcomes.",
          basis: "The response omits the signals used to validate the decision.",
          sourceTurnIds: ["turn-2"],
        },
      ],
    });
    const accepted = materializeCheckpointReportCandidate({
      chainId: "chain-1",
      humanTurns: [humanTurn],
      evaluations: [evaluation],
      benchmarkBatch: benchmarkBatch.batch,
      candidate,
      generation: checkpointGeneration,
      createId: () => "finding-1",
      completedAt: "2026-09-06T08:04:00.000Z",
    });
    expect(accepted).toMatchObject({
      status: "accepted",
      checkpoint: {
        chainId: "chain-1",
        status: "completed",
        findings: [
          {
            id: "finding-1",
            priority: 1,
            calibration: "unreviewed",
            targetDimension: "evidence_and_outcome",
          },
        ],
      },
    });

    const badExcerpt = structuredClone(candidate);
    badExcerpt.comparisons[0].differences[0].benchmarkExcerpt = "not in benchmark";
    expect(
      materializeCheckpointReportCandidate({
        chainId: "chain-1",
        humanTurns: [humanTurn],
        evaluations: [evaluation],
        benchmarkBatch: benchmarkBatch.batch,
        candidate: badExcerpt,
        generation: checkpointGeneration,
        createId: () => "unused",
        completedAt: "2026-09-06T08:04:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "checkpoint_excerpt_not_found" });

    const duplicateFinding = structuredClone(candidate);
    duplicateFinding.findings.push({ ...duplicateFinding.findings[0], summary: "Duplicate" });
    expect(
      materializeCheckpointReportCandidate({
        chainId: "chain-1",
        humanTurns: [humanTurn],
        evaluations: [evaluation],
        benchmarkBatch: benchmarkBatch.batch,
        candidate: duplicateFinding,
        generation: checkpointGeneration,
        createId: () => "unused",
        completedAt: "2026-09-06T08:04:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "finding_dimension_duplicate" });

    const missingDifference = structuredClone(candidate);
    missingDifference.comparisons[0].differences = [];
    expect(
      materializeCheckpointReportCandidate({
        chainId: "chain-1",
        humanTurns: [humanTurn],
        evaluations: [evaluation],
        benchmarkBatch: benchmarkBatch.batch,
        candidate: missingDifference,
        generation: checkpointGeneration,
        createId: () => "unused",
        completedAt: "2026-09-06T08:04:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "checkpoint_dimension_mismatch" });

    const unsupportedFinding = structuredClone(candidate);
    unsupportedFinding.findings[0].targetDimension = "ownership_scope";
    expect(
      materializeCheckpointReportCandidate({
        chainId: "chain-1",
        humanTurns: [humanTurn],
        evaluations: [evaluation],
        benchmarkBatch: benchmarkBatch.batch,
        candidate: unsupportedFinding,
        generation: checkpointGeneration,
        createId: () => "unused",
        completedAt: "2026-09-06T08:04:00.000Z",
      }),
    ).toEqual({ status: "rejected", reason: "finding_source_mismatch" });

    const zeroFinding = structuredClone(candidate);
    zeroFinding.findings = [];
    expect(
      materializeCheckpointReportCandidate({
        chainId: "chain-1",
        humanTurns: [humanTurn],
        evaluations: [evaluation],
        benchmarkBatch: benchmarkBatch.batch,
        candidate: zeroFinding,
        generation: checkpointGeneration,
        createId: () => "unused",
        completedAt: "2026-09-06T08:04:00.000Z",
      }),
    ).toMatchObject({ status: "accepted", checkpoint: { findings: [] } });
  });

  it.each([1, 2, 3, 4])(
    "supports %i human turns and merges one dimension across turns",
    (turnCount) => {
      const turns = Array.from({ length: turnCount }, (_, index) => ({
        ...structuredClone(humanTurn),
        id: `turn-${index + 1}`,
        ordinal: index + 1,
      }));
      const evaluations = turns.map((turn) => ({
        turnId: turn.id,
        rubricVersion: "answer-rubric-v1" as const,
        dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
          dimension,
          verdict: dimension === "evidence_and_outcome" ? "partial" as const : "met" as const,
          rationale: "Grounded rubric rationale.",
          answerExcerpts: ["idempotent retries"],
        })) as TurnEvaluation["dimensions"],
        generation: judgeGeneration,
        createdAt: "2026-09-06T08:02:00.000Z",
      }));
      const benchmarkBatch = materializeBenchmarkBatchCandidate({
        humanTurns: turns,
        candidate: {
          benchmarks: turns.map((turn) => ({
            turnId: turn.id,
            text: "I would validate duplicate-rate signals.",
            evidenceAnchorIds: ["anchor-1"],
          })),
        },
        generation: benchmarkGeneration,
        createdAt: "2026-09-06T08:03:00.000Z",
      });
      if (benchmarkBatch.status !== "accepted") throw new Error("benchmark was rejected");
      const result = materializeCheckpointReportCandidate({
        chainId: "chain-1",
        humanTurns: turns,
        evaluations,
        benchmarkBatch: benchmarkBatch.batch,
        candidate: {
          comparisons: turns.map((turn) => ({
            turnId: turn.id,
            differences: [
              {
                dimension: "evidence_and_outcome",
                explanation: "The answer omits a validation signal.",
                answerExcerpt: "idempotent retries",
                benchmarkExcerpt: "duplicate-rate signals",
              },
            ],
          })),
          findings: [
            {
              targetDimension: "evidence_and_outcome",
              summary: "Connect the decision to measurable outcomes.",
              basis: "The same gap appears across the sourced answers.",
              sourceTurnIds: turns.map((turn) => turn.id),
            },
          ],
        },
        generation: checkpointGeneration,
        createId: () => "finding-merged",
        completedAt: "2026-09-06T08:04:00.000Z",
      });
      expect(result).toMatchObject({
        status: "accepted",
        checkpoint: {
          findings: [
            {
              id: "finding-merged",
              priority: 1,
              sourceTurnIds: turns.map((turn) => turn.id),
            },
          ],
        },
      });
      if (result.status !== "accepted") throw new Error("checkpoint was rejected");
      expect(result.checkpoint.evaluations).toHaveLength(turnCount);
      expect(result.checkpoint.comparisons).toHaveLength(turnCount);
    },
  );

  it("keeps a partially generated Checkpoint out of the public Session projection", () => {
    const state = sessionStateV4Schema.parse({
      stateVersion: 4,
      phase: "active",
      interviewLanguage: "en-US",
      policy: CORE_LOOP_V3_POLICY,
      planRecord: null,
      execution: null,
      checkpoint: {
        status: "evaluating",
        chainId: "chain-1",
        humanTurnIds: ["turn-2"],
        evaluations: [],
        benchmarkBatch: null,
        result: null,
        startedAt: "2026-09-06T08:02:00.000Z",
      },
      activeOperation: {
        type: "generate_checkpoint",
        token: "private-operation-token",
        idempotencyKey: "checkpoint-1",
        priorPhase: "active",
        startedAt: "2026-09-06T08:02:00.000Z",
      },
      failedOperation: null,
    });

    expect(projectSessionState(state)).toMatchObject({
      activeOperation: "generate_checkpoint",
      checkpoint: null,
    });
    expect(JSON.stringify(projectSessionState(state))).not.toContain("private-operation-token");
    expect(JSON.stringify(projectSessionState(state))).not.toContain("checkpoint-1");
  });
});
