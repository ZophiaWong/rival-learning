import "server-only";

import { getServerConfig } from "@/server/config";
import type { ServerConfig } from "@/server/config/server-config";
import { RUBRIC_DIMENSIONS } from "@/server/core-loop/domain";
import { createInterviewAgents } from "@/server/interview-agents";
import { OpenRouterRoleRunner } from "@/server/interview-agents/role-runner/openrouter";
import { ScriptedRoleRunner } from "@/server/interview-agents/role-runner/scripted";
import { scriptedRoleRunnerEnabled } from "@/server/interview-agents/runtime";
import {
  createPreparationProfiles,
  type PreparationProfiles,
} from "@/server/preparation-profiles";
import { migrateDatabase } from "@/server/persistence/migrate";
import { createSessionEngine, type SessionEngine } from "@/server/session-engine";

export interface RivalLearningApplication {
  preparationProfiles: PreparationProfiles;
  sessionEngine: SessionEngine;
}

const globalApplication = globalThis as typeof globalThis & {
  rivalLearningApplication?: RivalLearningApplication;
};

function createApplicationInterviewAgents(config: ServerConfig) {
  if (scriptedRoleRunnerEnabled(process.env)) {
    const roleRunner = new ScriptedRoleRunner([
      {
        status: "success",
        value: {
          outcome: {
            status: "ready",
            intent: "ownership_claim_depth",
            knowledgeTarget: "验证候选人对该成果的实际责任、关键决策与结果证据。",
            evidenceAnchors: [{ source: "resume", startLine: 2, endLine: 2 }],
            initialDifficulty: "target",
            difficultyBasis: {
              signals: ["quantified_outcome"],
              explanation: "资料包含量化结果，需要进一步确认个人决策与责任范围。",
            },
            estimatedDepth: 3,
          },
        },
      },
      (request) => {
        const payload = JSON.parse(request.input) as {
          plan: { attackChains: [{ evidenceAnchors: Array<{ id: string }> }] };
        };
        return {
          status: "success",
          value: {
            outcome: {
              status: "ask",
              question: {
                text: "这项成果中你亲自负责的范围是什么，哪项关键决策由你做出？",
                difficulty: "target",
                evidenceAnchorIds: [payload.plan.attackChains[0].evidenceAnchors[0].id],
              },
            },
          },
        };
      },
      {
        status: "success",
        value: {
          outcome: {
            text:
              "我亲自负责迁移范围与回滚决策，并选择幂等重试来降低重复处理风险。现有资料没有记录更细的团队分工；如果需要在真实面试中展开，我会先明确我负责的服务边界与可验证指标。",
          },
        },
      },
      (request) => {
        const payload = JSON.parse(request.input) as {
          plan: { attackChains: [{ evidenceAnchors: Array<{ id: string }> }] };
        };
        return {
          status: "success",
          value: {
            outcome: {
              status: "ask",
              question: {
                text: "你为什么选择幂等重试，而不是依赖一次性投递或人工补偿？",
                difficulty: "target",
                evidenceAnchorIds: [payload.plan.attackChains[0].evidenceAnchors[0].id],
              },
            },
          },
        };
      },
      (request) => {
        const payload = JSON.parse(request.input) as {
          plan: { attackChains: [{ evidenceAnchors: Array<{ id: string }> }] };
        };
        return {
          status: "success",
          value: {
            outcome: {
              status: "ask",
              question: {
                text: "如果迁移指标开始恶化，你会依据哪些信号触发回滚？",
                difficulty: "target",
                evidenceAnchorIds: [payload.plan.attackChains[0].evidenceAnchors[0].id],
              },
            },
          },
        };
      },
      (request) => {
        const payload = JSON.parse(request.input) as {
          currentTurn: { question: string; answer: string };
        };
        const rollbackQuestion = payload.currentTurn.question.includes("回滚");
        const partialDimension = rollbackQuestion
          ? "target_level_depth"
          : "evidence_and_outcome";
        const excerpt = rollbackQuestion ? "持续越过阈值" : "人工补偿成本";
        return {
          status: "success",
          value: {
            outcome: {
              dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
                dimension,
                verdict: dimension === partialDimension ? "partial" : "met",
                rationale:
                  dimension === partialDimension
                    ? "回答给出了方向，但还缺少可验证的结果或高级判断深度。"
                    : "回答覆盖了该维度。",
                answerExcerpts: dimension === partialDimension ? [excerpt] : [],
              })),
            },
          },
        };
      },
      (request) => {
        const payload = JSON.parse(request.input) as {
          currentTurn: { question: string; answer: string };
        };
        const rollbackQuestion = payload.currentTurn.question.includes("回滚");
        const partialDimension = rollbackQuestion
          ? "target_level_depth"
          : "evidence_and_outcome";
        const excerpt = rollbackQuestion ? "持续越过阈值" : "人工补偿成本";
        return {
          status: "success",
          value: {
            outcome: {
              dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({
                dimension,
                verdict: dimension === partialDimension ? "partial" : "met",
                rationale:
                  dimension === partialDimension
                    ? "回答给出了方向，但还缺少可验证的结果或高级判断深度。"
                    : "回答覆盖了该维度。",
                answerExcerpts: dimension === partialDimension ? [excerpt] : [],
              })),
            },
          },
        };
      },
      (request) => {
        const payload = JSON.parse(request.input) as {
          humanQuestions: Array<{
            turnId: string;
            evidenceAnchorIds: string[];
          }>;
        };
        const benchmarkTexts = [
          "我会先量化重复率、恢复时长和人工补偿成本，再用压测与灰度结果验证幂等重试的收益。",
          "我会设定重复率和尾延迟阈值；如果连续三个观测窗口恶化，就停止扩量并按预案回滚。",
        ];
        return {
          status: "success",
          value: {
            outcome: {
              benchmarks: payload.humanQuestions.map((question, index) => ({
                turnId: question.turnId,
                text: benchmarkTexts[index],
                evidenceAnchorIds: [question.evidenceAnchorIds[0]],
              })),
            },
          },
        };
      },
      (request) => {
        const payload = JSON.parse(request.input) as {
          humanTurns: Array<{ turnId: string }>;
        };
        return {
          status: "success",
          value: {
            outcome: {
              comparisons: [
                {
                  turnId: payload.humanTurns[0].turnId,
                  differences: [
                    {
                      dimension: "evidence_and_outcome",
                      explanation: "原回答说明了权衡项，但 Benchmark 进一步给出量化验证方法。",
                      answerExcerpt: "人工补偿成本",
                      benchmarkExcerpt: "量化重复率",
                    },
                  ],
                },
                {
                  turnId: payload.humanTurns[1].turnId,
                  differences: [
                    {
                      dimension: "target_level_depth",
                      explanation: "原回答给出回滚方向，但 Benchmark 明确了持续性判断窗口。",
                      answerExcerpt: "持续越过阈值",
                      benchmarkExcerpt: "连续三个观测窗口",
                    },
                  ],
                },
              ],
              findings: [
                {
                  targetDimension: "evidence_and_outcome",
                  summary: "把技术选择连接到可量化的验证结果。",
                  basis: "权衡项清楚，但还需要说明如何通过指标验证决策。",
                  sourceTurnIds: [payload.humanTurns[0].turnId],
                },
                {
                  targetDimension: "target_level_depth",
                  summary: "为回滚判断定义持续窗口与阈值。",
                  basis: "触发信号已给出，但高级判断需要明确持续性标准。",
                  sourceTurnIds: [payload.humanTurns[1].turnId],
                },
              ],
            },
          },
        };
      },
      {
        status: "success",
        value: {
          outcome: {
            status: "ready",
            intent: "ownership_claim_depth",
            knowledgeTarget: "验证候选人对该成果的实际责任、关键决策与结果证据。",
            evidenceAnchors: [{ source: "resume", startLine: 2, endLine: 2 }],
            initialDifficulty: "target",
            difficultyBasis: {
              signals: ["quantified_outcome"],
              explanation: "资料包含量化结果，需要进一步确认个人决策与责任范围。",
            },
            estimatedDepth: 1,
          },
        },
      },
      (request) => {
        const payload = JSON.parse(request.input) as {
          plan: { attackChains: [{ evidenceAnchors: Array<{ id: string }> }] };
        };
        return {
          status: "success",
          value: {
            outcome: {
              status: "ask",
              question: {
                text: "这项成果中你亲自负责的关键决策是什么？",
                difficulty: "target",
                evidenceAnchorIds: [payload.plan.attackChains[0].evidenceAnchors[0].id],
              },
            },
          },
        };
      },
      {
        status: "success",
        value: {
          outcome: {
            text: "我负责迁移与回滚决策，并会用可验证指标说明取舍。",
          },
        },
      },
    ]);
    return createInterviewAgents(roleRunner);
  }
  return createInterviewAgents(new OpenRouterRoleRunner(config));
}

export function getApplication(): RivalLearningApplication {
  if (globalApplication.rivalLearningApplication) {
    return globalApplication.rivalLearningApplication;
  }

  const config = getServerConfig();
  const interviewAgents = createApplicationInterviewAgents(config);
  migrateDatabase(config.databasePath);
  const preparationProfiles = createPreparationProfiles({ databasePath: config.databasePath });
  const sessionEngine = createSessionEngine({
    databasePath: config.databasePath,
    preparationProfiles,
    interviewAgents,
  });

  globalApplication.rivalLearningApplication = { preparationProfiles, sessionEngine };
  return globalApplication.rivalLearningApplication;
}
