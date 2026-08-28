import { describe, expect, it } from "vitest";

import {
  getProviderConfigurationStatus,
  parseServerConfig,
  ServerConfigError,
} from "@/server/config/server-config";

describe("server configuration interface", () => {
  it("rejects missing required local runtime configuration without exposing environment values", () => {
    const secret = "sk-test-config-must-not-leak";

    expect(() =>
      parseServerConfig({
        RIVAL_INTERVIEWER_API_KEY: secret,
      }),
    ).toThrow(ServerConfigError);

    try {
      parseServerConfig({ RIVAL_INTERVIEWER_API_KEY: secret });
    } catch (error) {
      expect(error).toBeInstanceOf(ServerConfigError);
      expect(String(error)).toContain("RIVAL_DATABASE_PATH");
      expect(String(error)).toContain("RIVAL_HOST");
      expect(String(error)).not.toContain(secret);
    }
  });

  it("reports provider readiness without exposing API keys", () => {
    const secret = "sk-test-status-must-not-leak";
    const config = parseServerConfig({
      RIVAL_DATABASE_PATH: ".data/test.db",
      RIVAL_HOST: "127.0.0.1",
      RIVAL_INTERVIEWER_PROVIDER: "openrouter",
      RIVAL_INTERVIEWER_MODEL: "provider/model-slug",
      RIVAL_INTERVIEWER_API_KEY: secret,
    });

    const status = getProviderConfigurationStatus(config);

    expect(status).toEqual({
      interviewer: {
        configured: true,
        provider: "openrouter",
        model: "provider/model-slug",
      },
      candidate: { configured: false, provider: null, model: null },
      judge: { configured: false, provider: null, model: null },
    });
    expect(JSON.stringify(status)).not.toContain(secret);
  });
});
