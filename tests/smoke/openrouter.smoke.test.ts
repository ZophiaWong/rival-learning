import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  getProviderConfigurationStatus,
  parseServerConfig,
  type RoleName,
} from "@/server/config/server-config";
import { OpenRouterRoleRunner } from "@/server/interview-agents/role-runner/openrouter";

const roles: readonly RoleName[] = ["interviewer", "candidate", "judge"];
const liveTestsEnabled = process.env.RIVAL_RUN_LIVE_TESTS === "1";

describe.skipIf(!liveTestsEnabled)("OpenRouter live smoke", () => {
  const config = parseServerConfig({
    ...process.env,
    RIVAL_DATABASE_PATH: process.env.RIVAL_DATABASE_PATH ?? ".data/live-smoke.db",
    RIVAL_HOST: "127.0.0.1",
  });
  const status = getProviderConfigurationStatus(config);
  const runner = new OpenRouterRoleRunner(config);

  for (const role of roles) {
    it(`${role} returns a short structured response`, async () => {
      const roleStatus = status[role];
      if (roleStatus.status !== "configured") {
        throw new Error(
          `${role} provider configuration is ${roleStatus.status}; missing: ${roleStatus.missingFields.join(", ") || "none"}`,
        );
      }

      const result = await runner.runStructured({
        role,
        operation: "live_smoke",
        instructions:
          "Return a synthetic health-check result. Do not request or infer personal data.",
        input: "Return {\"ok\": true}.",
        outputSchema: z.object({ ok: z.literal(true) }),
      });
      const summary = {
        role,
        provider: roleStatus.provider,
        model: roleStatus.model,
        attempts: result.attempts.length,
        usageComplete: result.usage.usageComplete,
        pass: result.status === "success",
      };
      console.log(JSON.stringify(summary));

      expect(result.status, `${role} live smoke failed`).toBe("success");
    });
  }
});
