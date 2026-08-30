import { createServer, type Server } from "node:http";
import { once } from "node:events";

import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { parseServerConfig } from "@/server/config/server-config";
import { OpenRouterRoleRunner } from "@/server/interview-agents/role-runner/openrouter";

interface CapturedRequest {
  url: string;
  authorizationPresent: boolean;
  body: Record<string, unknown>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  destroy?: boolean;
  streamChunks?: Array<Record<string, unknown>>;
  interruptStream?: boolean;
  streamDelayMs?: number;
}

async function startMockServer(responses: MockResponse[]) {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      url: request.url ?? "",
      authorizationPresent: Boolean(request.headers.authorization),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    });

    const scripted = responses.shift();
    if (!scripted) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unexpected request" } }));
      return;
    }

    if (scripted.destroy) {
      request.socket.destroy();
      return;
    }
    if (scripted.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, scripted.delayMs));
    }

    if (scripted.streamChunks) {
      response.writeHead(scripted.status ?? 200, {
        "content-type": "text/event-stream",
        "x-request-id": `mock-request-${requests.length}`,
        ...scripted.headers,
      });
      response.flushHeaders();
      for (const chunk of scripted.streamChunks) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        if (scripted.streamDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, scripted.streamDelayMs));
        }
      }
      if (scripted.interruptStream) {
        response.destroy();
      } else {
        response.end("data: [DONE]\n\n");
      }
      return;
    }

    response.writeHead(scripted.status ?? 200, {
      "content-type": "application/json",
      "x-request-id": `mock-request-${requests.length}`,
      ...scripted.headers,
    });
    response.end(JSON.stringify(scripted.body));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind");

  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests };
}

function completion(content: unknown, usage: unknown = {
  prompt_tokens: 7,
  completion_tokens: 3,
  total_tokens: 10,
}) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test/exact-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

function streamChunk(options: {
  content?: string;
  finishReason?: "stop" | null;
  usage?: Record<string, number> | null;
}) {
  return {
    id: "chatcmpl-stream-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "test/exact-model",
    choices: [
      {
        index: 0,
        delta: options.content === undefined ? {} : { content: options.content },
        finish_reason: options.finishReason ?? null,
      },
    ],
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  };
}

function successfulStructuredStream(answer = "hello") {
  const payload = JSON.stringify({ answer });
  return [
    streamChunk({ content: payload.slice(0, Math.ceil(payload.length / 2)) }),
    streamChunk({ content: payload.slice(Math.ceil(payload.length / 2)) }),
    streamChunk({
      finishReason: "stop",
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }),
  ];
}

function configuredEnvironment(secret: string) {
  return parseServerConfig({
    RIVAL_DATABASE_PATH: ".data/test.db",
    RIVAL_HOST: "127.0.0.1",
    RIVAL_INTERVIEWER_PROVIDER: "openrouter",
    RIVAL_INTERVIEWER_MODEL: "test/exact-model",
    RIVAL_INTERVIEWER_API_KEY: secret,
  });
}

describe("OpenRouterRoleRunner", () => {
  it("sends one structured Chat Completions request with fixed routing and privacy settings", async () => {
    const secret = "sk-test-production-canary";
    const mock = await startMockServer([{ body: completion({ answer: "hello" }) }]);
    const clientOptions = vi.fn();
    const runner = new OpenRouterRoleRunner(configuredEnvironment(secret), {
      createClient(options) {
        clientOptions(options);
        return new OpenAI({ ...options, baseURL: mock.baseURL });
      },
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "contract_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
    });

    expect(result).toEqual({
      status: "success",
      value: { answer: "hello" },
      attempts: [
        expect.objectContaining({
          attempt: 1,
          providerId: "openrouter",
          model: "test/exact-model",
          outcome: "succeeded",
          httpStatus: 200,
          requestId: "mock-request-1",
          inputTokens: 7,
          outputTokens: 3,
        }),
      ],
      usage: {
        requests: 1,
        inputTokens: 7,
        outputTokens: 3,
        usageComplete: true,
      },
    });
    expect(clientOptions).toHaveBeenCalledWith({
      apiKey: secret,
      baseURL: "https://openrouter.ai/api/v1",
      maxRetries: 0,
    });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({
      url: "/v1/chat/completions",
      authorizationPresent: true,
      body: {
        model: "test/exact-model",
        store: false,
        provider: { require_parameters: true, data_collection: "deny" },
        metadata: {
          app: "rival-learning",
          role: "interviewer",
          operation: "contract_test",
        },
        response_format: {
          type: "json_schema",
          json_schema: expect.objectContaining({ strict: true }),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("returns safe typed configuration failures without making a request", async () => {
    const missing = new OpenRouterRoleRunner(
      parseServerConfig({
        RIVAL_DATABASE_PATH: ".data/test.db",
        RIVAL_HOST: "127.0.0.1",
      }),
    );
    const unsupported = new OpenRouterRoleRunner(
      parseServerConfig({
        RIVAL_DATABASE_PATH: ".data/test.db",
        RIVAL_HOST: "127.0.0.1",
        RIVAL_INTERVIEWER_PROVIDER: "deepseek-direct",
        RIVAL_INTERVIEWER_MODEL: "deepseek-chat",
        RIVAL_INTERVIEWER_API_KEY: "sk-test-unsupported",
      }),
    );
    const request = {
      role: "interviewer" as const,
      operation: "configuration_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
    };

    await expect(missing.runStructured(request)).resolves.toMatchObject({
      status: "failure",
      error: { code: "provider_not_configured" },
      attempts: [],
      usage: { requests: 0 },
    });
    await expect(unsupported.runStructured(request)).resolves.toMatchObject({
      status: "failure",
      error: { code: "provider_unsupported" },
      attempts: [],
      usage: { requests: 0 },
    });
  });

  it.each([408, 409, 429, 500, 503])(
    "retries retryable HTTP %i responses and preserves every attempt",
    async (status) => {
      const mock = await startMockServer([
        { status, body: { error: { message: "transient provider body" } } },
        { body: completion({ answer: "recovered" }) },
      ]);
      const sleep = vi.fn(async () => undefined);
      const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-retry"), {
        createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
        sleep,
      });

      const result = await runner.runStructured({
        role: "interviewer",
        operation: "retry_test",
        instructions: "Synthetic instructions",
        input: "Synthetic input",
        outputSchema: z.object({ answer: z.string() }),
      });

      expect(result.status).toBe("success");
      expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
        status === 408 ? "timeout" : "http_error",
        "succeeded",
      ]);
      expect(result.usage.requests).toBe(2);
      expect(result.usage.usageComplete).toBe(false);
      expect(sleep).toHaveBeenCalledWith(500, undefined);
      expect(mock.requests).toHaveLength(2);
    },
  );

  it("uses at most three attempts with 500ms then 1000ms application retry delays", async () => {
    const mock = await startMockServer([
      { status: 500, body: { error: { message: "first" } } },
      { status: 500, body: { error: { message: "second" } } },
      { status: 500, body: { error: { message: "third" } } },
    ]);
    const sleep = vi.fn(async (milliseconds: number, signal?: AbortSignal) => {
      void milliseconds;
      void signal;
    });
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-final-failure"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      sleep,
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "final_failure_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
    });

    expect(result).toMatchObject({
      status: "failure",
      error: { code: "provider_unavailable" },
      usage: { requests: 3, usageComplete: false },
    });
    expect(result.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([500, 1000]);
    expect(mock.requests).toHaveLength(3);
  });

  it.each([
    [401, "provider_auth_failed"],
    [402, "provider_quota_exhausted"],
    [403, "provider_rejected"],
    [404, "model_not_found"],
    [422, "provider_rejected"],
  ] as const)("does not retry HTTP %i", async (status, code) => {
    const mock = await startMockServer([
      { status, body: { error: { message: "must remain private" } } },
    ]);
    const sleep = vi.fn(async () => undefined);
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-no-retry"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      sleep,
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "no_retry_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
    });

    expect(result).toMatchObject({ status: "failure", error: { code } });
    expect(result.attempts).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(mock.requests).toHaveLength(1);
  });

  it("uses the larger Retry-After delay while capping it at ten seconds", async () => {
    const mock = await startMockServer([
      {
        status: 429,
        headers: { "retry-after": "20" },
        body: { error: { message: "rate limited" } },
      },
      { body: completion({ answer: "recovered" }) },
    ]);
    const sleep = vi.fn(async () => undefined);
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-retry-after"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      sleep,
    });

    await runner.runStructured({
      role: "interviewer",
      operation: "retry_after_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
    });

    expect(sleep).toHaveBeenCalledWith(10_000, undefined);
  });

  it("retries network errors and cooperative attempt timeouts", async () => {
    const networkMock = await startMockServer([
      { destroy: true, body: null },
      { body: completion({ answer: "network recovered" }) },
    ]);
    const networkRunner = new OpenRouterRoleRunner(
      configuredEnvironment("sk-test-network"),
      {
        createClient: (options) => new OpenAI({ ...options, baseURL: networkMock.baseURL }),
        sleep: async () => undefined,
      },
    );
    const timeoutMock = await startMockServer([
      { delayMs: 40, body: completion({ answer: "too late" }) },
      { body: completion({ answer: "timeout recovered" }) },
    ]);
    const timeoutRunner = new OpenRouterRoleRunner(
      configuredEnvironment("sk-test-timeout"),
      {
        createClient: (options) => new OpenAI({ ...options, baseURL: timeoutMock.baseURL }),
        attemptTimeoutMs: 10,
        sleep: async () => undefined,
      },
    );
    const request = {
      role: "interviewer" as const,
      operation: "transport_retry_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
    };

    const [networkResult, timeoutResult] = await Promise.all([
      networkRunner.runStructured(request),
      timeoutRunner.runStructured(request),
    ]);

    expect(networkResult.attempts.map((attempt) => attempt.outcome)).toEqual([
      "network_error",
      "succeeded",
    ]);
    expect(timeoutResult.attempts.map((attempt) => attempt.outcome)).toEqual([
      "timeout",
      "succeeded",
    ]);
  });

  it("retries schema-invalid output with only sanitized Zod issue guidance", async () => {
    const invalidRawCanary = "provider-invalid-output-must-not-replay";
    const mock = await startMockServer([
      { body: completion({ answer: 42, private: invalidRawCanary }) },
      { body: completion({ answer: "corrected" }) },
    ]);
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-schema-retry"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      sleep: async () => undefined,
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "schema_retry_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
    });

    expect(result.status).toBe("success");
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      "schema_invalid",
      "succeeded",
    ]);
    const secondRequest = JSON.stringify(mock.requests[1]?.body);
    const secondMessages = mock.requests[1]?.body.messages as Array<{
      role: string;
      content: string;
    }>;
    const correctionInstructions = secondMessages.find(
      (message) => message.role === "system",
    )?.content;
    expect(correctionInstructions).toContain("Schema correction for this fresh attempt");
    expect(correctionInstructions).toContain("answer");
    expect(correctionInstructions).toContain("string");
    expect(secondRequest).not.toContain(invalidRawCanary);
  });

  it("retries a streaming failure before any delta is delivered", async () => {
    const mock = await startMockServer([
      { status: 500, body: { error: { message: "transient" } } },
      { streamChunks: successfulStructuredStream("recovered") },
    ]);
    const deltas: string[] = [];
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-pre-delta"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      sleep: async () => undefined,
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "pre_delta_retry_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
      onOutputDelta(delta) {
        deltas.push(delta);
      },
    });

    expect(result.status).toBe("success");
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual([
      "http_error",
      "succeeded",
    ]);
    expect(deltas.join("")).toBe(JSON.stringify({ answer: "recovered" }));
  });

  it("does not replay after a streamed delta has been delivered", async () => {
    const mock = await startMockServer([
      {
        streamChunks: [streamChunk({ content: '{"answer":"partial' })],
        interruptStream: true,
        streamDelayMs: 10,
      },
      { streamChunks: successfulStructuredStream("must not run") },
    ]);
    const onOutputDelta = vi.fn(async () => undefined);
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-stream-latch"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      sleep: async () => undefined,
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "stream_latch_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
      onOutputDelta,
    });

    expect(result).toMatchObject({
      status: "failure",
      error: { code: "stream_interrupted" },
      attempts: [{ outcome: "stream_interrupted" }],
      usage: { requests: 1 },
    });
    expect(onOutputDelta).toHaveBeenCalledTimes(1);
    expect(mock.requests).toHaveLength(1);
  });

  it("does not replay when the output callback throws", async () => {
    const mock = await startMockServer([
      { streamChunks: successfulStructuredStream() },
      { streamChunks: successfulStructuredStream("must not run") },
    ]);
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-callback"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      sleep: async () => undefined,
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "callback_failure_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
      onOutputDelta() {
        throw new Error("private callback failure");
      },
    });

    expect(result).toMatchObject({
      status: "failure",
      error: { code: "stream_interrupted" },
    });
    expect(mock.requests).toHaveLength(1);
  });

  it("stops without replay when the user aborts a streaming run", async () => {
    const mock = await startMockServer([
      { streamChunks: successfulStructuredStream() },
      { streamChunks: successfulStructuredStream("must not run") },
    ]);
    const controller = new AbortController();
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-stream-abort"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      sleep: async () => undefined,
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "stream_abort_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
      signal: controller.signal,
      onOutputDelta() {
        controller.abort();
      },
    });

    expect(result).toMatchObject({ status: "failure", error: { code: "aborted" } });
    expect(mock.requests).toHaveLength(1);
  });

  it("marks usage incomplete when the provider omits token facts", async () => {
    const responseWithoutUsage = completion({ answer: "no usage" });
    delete (responseWithoutUsage as { usage?: unknown }).usage;
    const mock = await startMockServer([{ body: responseWithoutUsage }]);
    const runner = new OpenRouterRoleRunner(configuredEnvironment("sk-test-no-usage"), {
      createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
    });

    const result = await runner.runStructured({
      role: "interviewer",
      operation: "missing_usage_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: z.object({ answer: z.string() }),
    });

    expect(result).toMatchObject({
      status: "success",
      attempts: [{ inputTokens: null, outputTokens: null }],
      usage: {
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        usageComplete: false,
      },
    });
  });

  it("never returns or logs API keys, prompts, provider bodies, or headers", async () => {
    const apiKeyCanary = "sk-secret-canary-must-not-leak";
    const promptCanary = "prompt-canary-must-not-leak";
    const providerBodyCanary = "provider-body-canary-must-not-leak";
    const providerHeaderCanary = "provider-header-canary-must-not-leak";
    const mock = await startMockServer([
      {
        status: 403,
        headers: { "x-private-provider-header": providerHeaderCanary },
        body: { error: { message: providerBodyCanary } },
      },
    ]);
    const consoleSpies = ["error", "warn", "log"].map((method) =>
      vi.spyOn(console, method as "error").mockImplementation(() => undefined),
    );

    try {
      const runner = new OpenRouterRoleRunner(configuredEnvironment(apiKeyCanary), {
        createClient: (options) => new OpenAI({ ...options, baseURL: mock.baseURL }),
      });
      const result = await runner.runStructured({
        role: "interviewer",
        operation: "secret_safety_test",
        instructions: promptCanary,
        input: promptCanary,
        outputSchema: z.object({ answer: z.string() }),
      });
      const serializedPublicResult = JSON.stringify({
        response: result,
        error: result.status === "failure" ? result.error : null,
        headers: "headers" in result ? result.headers : null,
      });
      const serializedLogs = JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls));

      for (const canary of [
        apiKeyCanary,
        promptCanary,
        providerBodyCanary,
        providerHeaderCanary,
      ]) {
        expect(serializedPublicResult).not.toContain(canary);
        expect(serializedLogs).not.toContain(canary);
      }
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });
});
