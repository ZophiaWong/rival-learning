import {
  benchmarkBatchSchema,
  checkpointSchema,
  turnEvaluationSchema,
  type BenchmarkBatch,
  type BenchmarkBatchCandidate,
  type Checkpoint,
  type CheckpointReportCandidate,
  type GenerationMetadata,
  type QuestionTurn,
  type TurnEvaluation,
  type TurnEvaluationCandidate,
} from "./domain";
import type { CoreLoopPolicy } from "./policy";

export type EvaluationSemanticRejectionReason =
  | "human_answer_required"
  | "evaluation_excerpt_not_found";

export type BenchmarkSemanticRejectionReason =
  | "benchmark_turn_mismatch"
  | "benchmark_evidence_mismatch";

export type CheckpointSemanticRejectionReason =
  | "checkpoint_turn_mismatch"
  | "checkpoint_dimension_mismatch"
  | "checkpoint_excerpt_not_found"
  | "finding_dimension_duplicate"
  | "finding_source_mismatch";

export function materializeTurnEvaluationCandidate(input: {
  turn: QuestionTurn;
  candidate: TurnEvaluationCandidate;
  generation: GenerationMetadata;
  rubricVersion: CoreLoopPolicy["rubricVersion"];
  createdAt: string;
}):
  | { status: "accepted"; evaluation: TurnEvaluation }
  | { status: "rejected"; reason: EvaluationSemanticRejectionReason } {
  const answer = input.turn.answer;
  if (!answer || answer.actor !== "human") {
    return { status: "rejected", reason: "human_answer_required" };
  }

  const hasUnknownExcerpt = input.candidate.dimensions.some((result) =>
    result.answerExcerpts.some((excerpt) => !answer.text.includes(excerpt)),
  );
  if (hasUnknownExcerpt) {
    return { status: "rejected", reason: "evaluation_excerpt_not_found" };
  }

  return {
    status: "accepted",
    evaluation: turnEvaluationSchema.parse({
      turnId: input.turn.id,
      rubricVersion: input.rubricVersion,
      dimensions: input.candidate.dimensions,
      generation: input.generation,
      createdAt: input.createdAt,
    }),
  };
}

export function materializeBenchmarkBatchCandidate(input: {
  humanTurns: QuestionTurn[];
  candidate: BenchmarkBatchCandidate;
  generation: GenerationMetadata;
  createdAt: string;
}):
  | { status: "accepted"; batch: BenchmarkBatch }
  | { status: "rejected"; reason: BenchmarkSemanticRejectionReason } {
  if (
    input.candidate.benchmarks.length !== input.humanTurns.length ||
    input.candidate.benchmarks.some(
      (benchmark, index) => benchmark.turnId !== input.humanTurns[index]?.id,
    )
  ) {
    return { status: "rejected", reason: "benchmark_turn_mismatch" };
  }

  const hasUnknownEvidence = input.candidate.benchmarks.some((benchmark, index) => {
    const allowed = new Set(input.humanTurns[index].question.evidenceAnchorIds);
    return (
      new Set(benchmark.evidenceAnchorIds).size !== benchmark.evidenceAnchorIds.length ||
      benchmark.evidenceAnchorIds.some((anchorId) => !allowed.has(anchorId))
    );
  });
  if (hasUnknownEvidence) {
    return { status: "rejected", reason: "benchmark_evidence_mismatch" };
  }

  return {
    status: "accepted",
    batch: benchmarkBatchSchema.parse({
      benchmarks: input.candidate.benchmarks,
      generation: input.generation,
      createdAt: input.createdAt,
    }),
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function materializeCheckpointReportCandidate(input: {
  chainId: string;
  humanTurns: QuestionTurn[];
  evaluations: TurnEvaluation[];
  benchmarkBatch: BenchmarkBatch;
  candidate: CheckpointReportCandidate;
  generation: GenerationMetadata;
  createId: () => string;
  completedAt: string;
}):
  | { status: "accepted"; checkpoint: Checkpoint }
  | { status: "rejected"; reason: CheckpointSemanticRejectionReason } {
  const turnIds = input.humanTurns.map((turn) => turn.id);
  if (
    !arraysEqual(input.evaluations.map((evaluation) => evaluation.turnId), turnIds) ||
    !arraysEqual(input.benchmarkBatch.benchmarks.map((benchmark) => benchmark.turnId), turnIds) ||
    !arraysEqual(input.candidate.comparisons.map((comparison) => comparison.turnId), turnIds)
  ) {
    return { status: "rejected", reason: "checkpoint_turn_mismatch" };
  }

  for (let index = 0; index < input.humanTurns.length; index += 1) {
    const evaluation = input.evaluations[index];
    const comparison = input.candidate.comparisons[index];
    const expectedDimensions = evaluation.dimensions
      .filter((result) => result.verdict === "partial" || result.verdict === "missing")
      .map((result) => result.dimension);
    const actualDimensions = comparison.differences.map((difference) => difference.dimension);
    if (!arraysEqual(actualDimensions, expectedDimensions)) {
      return { status: "rejected", reason: "checkpoint_dimension_mismatch" };
    }

    const answer = input.humanTurns[index].answer;
    const benchmark = input.benchmarkBatch.benchmarks[index];
    if (!answer || answer.actor !== "human") {
      return { status: "rejected", reason: "checkpoint_turn_mismatch" };
    }
    const invalidExcerpt = comparison.differences.some(
      (difference) =>
        (difference.answerExcerpt !== null && !answer.text.includes(difference.answerExcerpt)) ||
        !benchmark.text.includes(difference.benchmarkExcerpt),
    );
    if (invalidExcerpt) {
      return { status: "rejected", reason: "checkpoint_excerpt_not_found" };
    }
  }

  const findingDimensions = input.candidate.findings.map((finding) => finding.targetDimension);
  if (new Set(findingDimensions).size !== findingDimensions.length) {
    return { status: "rejected", reason: "finding_dimension_duplicate" };
  }

  const evaluationByTurn = new Map(
    input.evaluations.map((evaluation) => [evaluation.turnId, evaluation] as const),
  );
  for (const finding of input.candidate.findings) {
    if (new Set(finding.sourceTurnIds).size !== finding.sourceTurnIds.length) {
      return { status: "rejected", reason: "finding_source_mismatch" };
    }
    const everySourceSupportsFinding = finding.sourceTurnIds.every((turnId) => {
      const evaluation = evaluationByTurn.get(turnId);
      const result = evaluation?.dimensions.find(
        (dimension) => dimension.dimension === finding.targetDimension,
      );
      return result?.verdict === "partial" || result?.verdict === "missing";
    });
    if (!everySourceSupportsFinding) {
      return { status: "rejected", reason: "finding_source_mismatch" };
    }
  }

  return {
    status: "accepted",
    checkpoint: checkpointSchema.parse({
      status: "completed",
      chainId: input.chainId,
      evaluations: input.evaluations,
      benchmarkBatch: input.benchmarkBatch,
      comparisons: input.candidate.comparisons,
      findings: input.candidate.findings.map((finding, index) => ({
        ...finding,
        id: input.createId(),
        priority: index + 1,
        calibration: "unreviewed",
      })),
      generation: input.generation,
      completedAt: input.completedAt,
    }),
  };
}
