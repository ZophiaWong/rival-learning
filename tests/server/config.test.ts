import { describe, expect, it, vi } from "vitest";

import {
  getProviderConfigurationStatus,
  parseServerConfig,
  ServerConfigError,
} from "@/server/config/server-config";
import { errorResponse } from "@/server/http";

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

  it("does not serialize or log a canary secret from an unexpected error", async () => {
    const secret = "sk-test-unexpected-error-must-not-leak";
    const error = new Error(`Provider failed with ${secret}`);
    error.name = `ProviderError-${secret}`;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const response = errorResponse(error);
      const serializedResponse = JSON.stringify({
        body: await response.text(),
        headers: [...response.headers.entries()],
      });
      const serializedLogs = JSON.stringify(consoleError.mock.calls);

      expect(serializedResponse).not.toContain(secret);
      expect(serializedLogs).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });
});
