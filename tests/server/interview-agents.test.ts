import { describe, expect, it } from "vitest";

import { createInterviewAgents } from "@/server/interview-agents";
import type { InterviewPlan } from "@/server/core-loop/domain";
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
      publicTranscript: [],
      currentDifficulty: null,
      remainingDepth: 3,
      semanticRejections: [],
    });

    const payload = JSON.parse(captured!.input) as Record<string, unknown>;
    expect(payload).toHaveProperty("evidenceContext");
    expect(payload).toHaveProperty("hiringBar");
    expect(payload).not.toHaveProperty("providerView");
    expect(captured!.input).not.toContain(providerView.projectNotes);
    expect(captured?.onOutputDelta).toBeUndefined();
  });
});
