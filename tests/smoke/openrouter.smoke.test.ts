import { describe, expect, it } from "vitest";

import {
  acceptNextQuestionCandidate,
  createAttackChainExecutionState,
} from "@/server/core-loop/attack-chain-execution";
import type { InterviewLanguage } from "@/server/core-loop/domain";
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

describe.skipIf(!liveTestsEnabled)("OpenRouter Step 2 live smoke", () => {
  const config = parseServerConfig({
    ...process.env,
    RIVAL_DATABASE_PATH: process.env.RIVAL_DATABASE_PATH ?? ".data/live-smoke.db",
    RIVAL_HOST: "127.0.0.1",
  });
  const interviewerStatus = getProviderConfigurationStatus(config).interviewer;
  const agents = createInterviewAgents(new OpenRouterRoleRunner(config));
  const policy = createCoreLoopPolicySnapshot();

  function requireConfiguredInterviewer(): void {
    if (interviewerStatus.status !== "configured") {
      throw new Error(
        `interviewer provider configuration is ${interviewerStatus.status}; missing: ${interviewerStatus.missingFields.join(", ") || "none"}`,
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
});
