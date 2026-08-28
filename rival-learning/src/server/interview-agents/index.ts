import type { ProfileSnapshot } from "@/server/preparation-profiles";

export interface AgentUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface FoundationInterviewPlan {
  objective: string;
  evidenceAnchor: string;
}

export type AgentOperationResult<T> =
  | { status: "success"; value: T; usage: AgentUsage }
  | { status: "failure"; code: string; message: string; usage: AgentUsage };

export interface InterviewAgents {
  generatePlan(input: {
    operationToken: string;
    profileSnapshot: ProfileSnapshot;
  }): Promise<AgentOperationResult<FoundationInterviewPlan>>;
}
