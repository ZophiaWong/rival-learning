import type { InterviewAgents } from "./index";

export class FoundationFakeInterviewAgents implements InterviewAgents {
  async generatePlan(input: Parameters<InterviewAgents["generatePlan"]>[0]) {
    const evidenceAnchor =
      input.profileSnapshot.providerView.resume
        .split("\n")
        .find((line) => line.trim() && !line.includes("[REDACTED_")) ??
      input.profileSnapshot.providerView.projectNotes.split("\n").find((line) => line.trim()) ??
      "Confirmed ProviderView";

    return {
      status: "success" as const,
      value: {
        objective: "Foundation fake plan",
        evidenceAnchor,
      },
      usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
    };
  }
}
