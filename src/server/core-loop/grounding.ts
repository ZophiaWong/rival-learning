import type { ProviderViewContent } from "@/server/preparation-profiles";

import {
  interviewPlanRecordSchema,
  type AttackChainCandidate,
  type EvidenceAnchor,
  type EvidenceSource,
  type GenerationMetadata,
  type InterviewPlanRecord,
  type QuestionContextPacket,
} from "./domain";
import type { CoreLoopPolicy } from "./policy";

export type PlanSemanticRejectionReason =
  | "anchor_range_invalid"
  | "anchor_has_no_evidence"
  | "duplicate_evidence_anchor"
  | "difficulty_basis_inconsistent"
  | "duplicate_requested_evidence"
  | "context_too_large";

export type MaterializePlanResult =
  | { status: "accepted"; record: InterviewPlanRecord }
  | { status: "rejected"; reason: PlanSemanticRejectionReason };

export interface PlanningInputSizes {
  resume: number;
  projectNotes: number;
  jobDescription: number;
  targetRole: number;
  targetLevel: number;
  total: number;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function measurePlanningInput(providerView: ProviderViewContent): PlanningInputSizes {
  const sizes = {
    resume: unicodeLength(providerView.resume),
    projectNotes: unicodeLength(providerView.projectNotes),
    jobDescription: unicodeLength(providerView.jobDescription),
    targetRole: unicodeLength(providerView.targetRole),
    targetLevel: unicodeLength(providerView.targetLevel),
  };
  return { ...sizes, total: Object.values(sizes).reduce((sum, size) => sum + size, 0) };
}

function sourceText(providerView: ProviderViewContent, source: EvidenceSource): string {
  return source === "resume" ? providerView.resume : providerView.projectNotes;
}

function sourceLines(providerView: ProviderViewContent, source: EvidenceSource): string[] {
  return sourceText(providerView, source).split(/\r?\n/u);
}

function containsMeaningfulEvidence(lines: string[]): boolean {
  return lines.some((line) => {
    const withoutPlaceholders = line
      .replace(/\[REDACTED_[A-Z_]+\]/gu, "")
      .replace(
        /(?:name|email|phone|address|url|contact|姓名|邮箱|电话|地址|联系方式)\s*[:：-]?\s*/giu,
        "",
      )
      .replace(/[\p{P}\p{S}\s]/gu, "");
    return withoutPlaceholders.length > 0;
  });
}

function validateDifficulty(candidate: Extract<AttackChainCandidate, { status: "ready" }>): boolean {
  const signals = new Set(candidate.difficultyBasis.signals);
  if (signals.size !== candidate.difficultyBasis.signals.length) return false;
  if (
    candidate.initialDifficulty === "target" &&
    !signals.has("explicit_decision") &&
    !signals.has("quantified_outcome")
  ) {
    return false;
  }
  if (
    candidate.initialDifficulty === "stretch" &&
    (!signals.has("system_scope") || !signals.has("explicit_decision"))
  ) {
    return false;
  }
  return true;
}

interface LineRange {
  source: EvidenceSource;
  startLine: number;
  endLine: number;
}

function resumeBlock(lines: string[], anchor: EvidenceAnchor): LineRange {
  let startLine = anchor.startLine;
  let endLine = anchor.endLine;
  while (startLine > 1 && lines[startLine - 2]?.trim()) startLine -= 1;
  while (endLine < lines.length && lines[endLine]?.trim()) endLine += 1;
  return { source: anchor.source, startLine, endLine };
}

function headingLevel(line: string): number | null {
  const match = /^\s{0,3}(#{1,6})\s+\S/u.exec(line);
  return match ? match[1].length : null;
}

function projectSection(lines: string[], anchor: EvidenceAnchor): LineRange {
  let headingLine: number | null = null;
  let level: number | null = null;
  for (let lineNumber = anchor.startLine; lineNumber >= 1; lineNumber -= 1) {
    const candidateLevel = headingLevel(lines[lineNumber - 1] ?? "");
    if (candidateLevel !== null) {
      headingLine = lineNumber;
      level = candidateLevel;
      break;
    }
  }
  if (headingLine === null || level === null) {
    return resumeBlock(lines, anchor);
  }

  let endLine = lines.length;
  for (let lineNumber = Math.max(anchor.endLine + 1, headingLine + 1); lineNumber <= lines.length; lineNumber += 1) {
    const candidateLevel = headingLevel(lines[lineNumber - 1] ?? "");
    if (candidateLevel !== null && candidateLevel <= level) {
      endLine = lineNumber - 1;
      break;
    }
  }
  return { source: anchor.source, startLine: headingLine, endLine };
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sourceOrder: Record<EvidenceSource, number> = { resume: 0, project_notes: 1 };
  const sorted = [...ranges].sort(
    (left, right) =>
      sourceOrder[left.source] - sourceOrder[right.source] || left.startLine - right.startLine,
  );
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.source === range.source &&
      range.startLine <= previous.endLine + 1
    ) {
      previous.endLine = Math.max(previous.endLine, range.endLine);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function packetCharacterCount(lines: Array<{ text: string }>): number {
  return lines.reduce((total, line, index) => total + unicodeLength(line.text) + (index > 0 ? 1 : 0), 0);
}

function buildQuestionContext(
  providerView: ProviderViewContent,
  anchors: EvidenceAnchor[],
  policy: CoreLoopPolicy,
): QuestionContextPacket | null {
  const ranges = mergeRanges(
    anchors.map((anchor) => {
      const lines = sourceLines(providerView, anchor.source);
      return anchor.source === "project_notes"
        ? projectSection(lines, anchor)
        : resumeBlock(lines, anchor);
    }),
  );
  const evidenceByLine = new Map<string, string[]>();
  for (const anchor of anchors) {
    for (let lineNumber = anchor.startLine; lineNumber <= anchor.endLine; lineNumber += 1) {
      const key = `${anchor.source}:${lineNumber}`;
      evidenceByLine.set(key, [...(evidenceByLine.get(key) ?? []), anchor.id]);
    }
  }

  let lines = ranges.flatMap((range) => {
    const allLines = sourceLines(providerView, range.source);
    return Array.from({ length: range.endLine - range.startLine + 1 }, (_, index) => {
      const lineNumber = range.startLine + index;
      return {
        source: range.source,
        lineNumber,
        text: allLines[lineNumber - 1] ?? "",
        evidenceAnchorIds: evidenceByLine.get(`${range.source}:${lineNumber}`) ?? [],
      };
    });
  });

  const mandatory = lines.filter((line) => line.evidenceAnchorIds.length > 0);
  if (
    mandatory.length > policy.maxQuestionContextLines ||
    packetCharacterCount(mandatory) > policy.maxQuestionContextChars
  ) {
    return null;
  }

  const distanceToEvidence = (line: (typeof lines)[number]) => {
    const sameSource = mandatory.filter((item) => item.source === line.source);
    return sameSource.length === 0
      ? Number.MAX_SAFE_INTEGER
      : Math.min(...sameSource.map((item) => Math.abs(item.lineNumber - line.lineNumber)));
  };
  const removable = lines
    .filter((line) => line.evidenceAnchorIds.length === 0)
    .sort(
      (left, right) =>
        distanceToEvidence(right) - distanceToEvidence(left) || right.lineNumber - left.lineNumber,
    );
  while (
    lines.length > policy.maxQuestionContextLines ||
    packetCharacterCount(lines) > policy.maxQuestionContextChars
  ) {
    const remove = removable.shift();
    if (!remove) return null;
    lines = lines.filter(
      (line) => line.source !== remove.source || line.lineNumber !== remove.lineNumber,
    );
  }

  return {
    lines,
    totalLines: lines.length,
    totalCharacters: packetCharacterCount(lines),
  };
}

export function materializeInterviewPlanCandidate(input: {
  candidate: AttackChainCandidate;
  providerView: ProviderViewContent;
  generation: GenerationMetadata;
  policy: CoreLoopPolicy;
  createId: () => string;
  createdAt: string;
}): MaterializePlanResult {
  const { candidate, providerView, generation, policy, createId, createdAt } = input;
  if (candidate.status === "needs_input") {
    const kinds = candidate.requestedEvidence.map((item) => item.kind);
    if (new Set(kinds).size !== kinds.length) {
      return { status: "rejected", reason: "duplicate_requested_evidence" };
    }
    return {
      status: "accepted",
      record: interviewPlanRecordSchema.parse({
        plan: {
          id: createId(),
          policyVersion: policy.chainPolicyVersion,
          createdAt,
          attackChains: [{ ...candidate, id: createId() }],
        },
        questionContext: null,
        generation,
      }),
    };
  }

  if (!validateDifficulty(candidate)) {
    return { status: "rejected", reason: "difficulty_basis_inconsistent" };
  }

  const keys = candidate.evidenceAnchors.map(
    (anchor) => `${anchor.source}:${anchor.startLine}:${anchor.endLine}`,
  );
  if (new Set(keys).size !== keys.length) {
    return { status: "rejected", reason: "duplicate_evidence_anchor" };
  }

  const anchors: EvidenceAnchor[] = [];
  for (const rawAnchor of candidate.evidenceAnchors) {
    const lines = sourceLines(providerView, rawAnchor.source);
    const lineCount = rawAnchor.endLine - rawAnchor.startLine + 1;
    if (
      rawAnchor.endLine < rawAnchor.startLine ||
      lineCount > policy.maxEvidenceAnchorLines ||
      rawAnchor.endLine > lines.length
    ) {
      return { status: "rejected", reason: "anchor_range_invalid" };
    }
    const selected = lines.slice(rawAnchor.startLine - 1, rawAnchor.endLine);
    if (!containsMeaningfulEvidence(selected)) {
      return { status: "rejected", reason: "anchor_has_no_evidence" };
    }
    anchors.push({ ...rawAnchor, id: createId(), excerpt: selected.join("\n") });
  }

  const context = buildQuestionContext(providerView, anchors, policy);
  if (!context) return { status: "rejected", reason: "context_too_large" };

  return {
    status: "accepted",
    record: interviewPlanRecordSchema.parse({
      plan: {
        id: createId(),
        policyVersion: policy.chainPolicyVersion,
        createdAt,
        attackChains: [{ ...candidate, id: createId(), evidenceAnchors: anchors }],
      },
      questionContext: context,
      generation,
    }),
  };
}
