import type {
  AgentOperationResult,
  FoundationInterviewPlan,
  InterviewAgents,
} from "./index";

export type ScriptedPlanStep =
  | AgentOperationResult<FoundationInterviewPlan>
  | (() => Promise<AgentOperationResult<FoundationInterviewPlan>>);

export class ScriptedInterviewAgents implements InterviewAgents {
  private readonly planSteps: ScriptedPlanStep[];

  constructor(planSteps: ScriptedPlanStep[]) {
    this.planSteps = [...planSteps];
  }

  async generatePlan(): Promise<AgentOperationResult<FoundationInterviewPlan>> {
    const step = this.planSteps.shift();
    if (!step) {
      return {
        status: "failure",
        code: "script_exhausted",
        message: "No scripted plan result is available",
        usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
      };
    }
    return typeof step === "function" ? step() : step;
  }
}
