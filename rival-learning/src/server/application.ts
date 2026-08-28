import "server-only";

import { getServerConfig } from "@/server/config";
import { FoundationFakeInterviewAgents } from "@/server/interview-agents/foundation-fake";
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

export function getApplication(): RivalLearningApplication {
  if (globalApplication.rivalLearningApplication) {
    return globalApplication.rivalLearningApplication;
  }

  const config = getServerConfig();
  migrateDatabase(config.databasePath);
  const preparationProfiles = createPreparationProfiles({ databasePath: config.databasePath });
  const sessionEngine = createSessionEngine({
    databasePath: config.databasePath,
    preparationProfiles,
    interviewAgents: new FoundationFakeInterviewAgents(),
  });

  globalApplication.rivalLearningApplication = { preparationProfiles, sessionEngine };
  return globalApplication.rivalLearningApplication;
}
