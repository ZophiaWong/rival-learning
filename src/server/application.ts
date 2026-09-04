import "server-only";

import { getServerConfig } from "@/server/config";
import type { ServerConfig } from "@/server/config/server-config";
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
