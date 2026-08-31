import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import OpenAI from "openai";

import { parseServerConfig } from "@/server/config/server-config";
import { OpenRouterRoleRunner } from "@/server/interview-agents/role-runner/openrouter";
import {
  ScriptedRoleRunner,
  type ScriptedRoleRunStep,
} from "@/server/interview-agents/role-runner/scripted";
import type {
  ModelAttempt,
  RoleRunResult,
  RoleRunner,
} from "@/server/interview-agents/role-runner";

const answerSchema = z.object({ answer: z.string() });

const successfulAttempt: ModelAttempt = {
  attempt: 1,
  providerId: "openrouter",
  model: "test/model",
  outcome: "succeeded",
  httpStatus: 200,
  requestId: "request-1",
  durationMs: 12,
  inputTokens: 4,
  outputTokens: 2,
};

function runAnswer(runner: RoleRunner, signal?: AbortSignal) {
  return runner.runStructured({
    role: "interviewer",
    operation: "contract_test",
    instructions: "Synthetic instructions",
    input: "Synthetic input",
    outputSchema: answerSchema,
    signal,
  });
}

function runStreamedAnswer(
  runner: RoleRunner,
  onOutputDelta: (delta: string) => void | Promise<void>,
  signal?: AbortSignal,
) {
  return runner.runStructured({
    role: "interviewer",
    operation: "stream_contract_test",
    instructions: "Synthetic instructions",
    input: "Synthetic input",
    outputSchema: answerSchema,
    signal,
    onOutputDelta,
  });
}

function scripted(step: ScriptedRoleRunStep): RoleRunner {
  return new ScriptedRoleRunner([step]);
}

interface RoleRunnerContractHarness {
  success(): RoleRunner;
  failure(): RoleRunner;
  schemaInvalid(): RoleRunner;
  streamSuccess(): RoleRunner;
  streamFailureAfterDelta(): RoleRunner;
}

function scriptedHarness(): RoleRunnerContractHarness {
  return {
    success: () =>
      scripted({
        status: "success",
        value: { answer: "bounded response" },
        attempts: [successfulAttempt],
        usage: {
          requests: 1,
          inputTokens: 4,
          outputTokens: 2,
          usageComplete: true,
        },
      }),
    failure: () =>
      scripted({
        status: "failure",
        error: {
          code: "provider_auth_failed",
          message: "The provider rejected the configured credentials.",
        },
        attempts: [
          {
            ...successfulAttempt,
            outcome: "http_error",
            httpStatus: 401,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      }),
    schemaInvalid: () =>
      scripted({
        status: "success",
        value: { answer: 42 },
        attempts: [successfulAttempt],
      }),
    streamSuccess: () =>
      scripted({
        status: "success",
        value: { answer: "bounded response" },
        deltas: ['{"answer":"bounded response"}'],
        attempts: [successfulAttempt],
      }),
    streamFailureAfterDelta: () =>
      scripted({
        status: "success",
        value: { answer: 42 },
        deltas: ['{"answer":42}'],
        attempts: [{ ...successfulAttempt, outcome: "schema_invalid" }],
      }),
  };
}

function productionRunner(fetchImplementation: typeof fetch): RoleRunner {
  const config = parseServerConfig({
    RIVAL_DATABASE_PATH: ".data/test.db",
    RIVAL_HOST: "127.0.0.1",
    RIVAL_INTERVIEWER_PROVIDER: "openrouter",
    RIVAL_INTERVIEWER_MODEL: "test/model",
    RIVAL_INTERVIEWER_API_KEY: "sk-contract-test",
  });
  return new OpenRouterRoleRunner(config, {
    createClient: (options) => new OpenAI({ ...options, fetch: fetchImplementation }),
    sleep: async () => undefined,
  });
}

function productionResponse(content: unknown) {
  return {
    id: "chatcmpl-contract",
    object: "chat.completion",
    created: 1,
    model: "test/model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(content) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
}

function productionStreamResponse(content: string) {
  const chunks = [
    {
      id: "chatcmpl-contract-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "test/model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id: "chatcmpl-contract-stream",
      object: "chat.completion.chunk",
      created: 1,
      model: "test/model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    },
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
  });
}

function productionHarness(): RoleRunnerContractHarness {
  return {
    success: () =>
      productionRunner(async () =>
        new Response(JSON.stringify(productionResponse({ answer: "bounded response" })), {
          status: 200,
          headers: { "content-type": "application/json", "x-request-id": "request-1" },
        }),
      ),
    failure: () =>
      productionRunner(async () =>
        new Response(JSON.stringify({ error: { message: "private auth failure" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    schemaInvalid: () =>
      productionRunner(async () =>
        new Response(JSON.stringify(productionResponse({ answer: 42 })), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    streamSuccess: () =>
      productionRunner(async () =>
        productionStreamResponse('{"answer":"bounded response"}'),
      ),
    streamFailureAfterDelta: () =>
      productionRunner(async () => productionStreamResponse('{"answer":42}')),
  };
}

function defineRoleRunnerContract(
  name: string,
  createHarness: () => RoleRunnerContractHarness,
) {
  describe(`${name} RoleRunner contract`, () => {
  it("returns a Zod-inferred structured value with attempt and usage facts", async () => {
    const result: RoleRunResult<{ answer: string }> = await runAnswer(
      createHarness().success(),
    );

    expect(result).toMatchObject({
      status: "success",
      value: { answer: "bounded response" },
      attempts: [
        {
          providerId: "openrouter",
          model: "test/model",
          outcome: "succeeded",
          inputTokens: 4,
          outputTokens: 2,
        },
      ],
      usage: {
        requests: 1,
        inputTokens: 4,
        outputTokens: 2,
        usageComplete: true,
      },
    });
  });

  it("returns typed failures instead of throwing", async () => {
    await expect(runAnswer(createHarness().failure())).resolves.toMatchObject({
      status: "failure",
      error: { code: "provider_auth_failed" },
    });
  });

  it("rejects a value that does not satisfy the request schema", async () => {
    const result = await runAnswer(createHarness().schemaInvalid());

    expect(result).toMatchObject({
      status: "failure",
      error: { code: "schema_invalid" },
    });
    expect(result.attempts.every((attempt) => attempt.outcome === "schema_invalid")).toBe(
      true,
    );
  });

  it("honors an already-aborted signal without consuming a request", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = createHarness().success();

    const result = await runAnswer(runner, controller.signal);

    expect(result).toEqual({
      status: "failure",
      error: { code: "aborted", message: "The model request was aborted." },
      attempts: [],
      usage: {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        usageComplete: true,
      },
    });
  });

  it("does not replay a schema failure after delivering a streamed delta", async () => {
    const onOutputDelta = vi.fn(async () => undefined);

    const result = await runStreamedAnswer(
      createHarness().streamFailureAfterDelta(),
      onOutputDelta,
    );

    expect(onOutputDelta).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failure",
      error: { code: "stream_interrupted" },
      attempts: [{ outcome: "stream_interrupted" }],
      usage: { requests: 1 },
    });
  });

  it("stops without replay when aborted after delivering a streamed delta", async () => {
    const controller = new AbortController();

    const result = await runStreamedAnswer(
      createHarness().streamSuccess(),
      () => controller.abort(),
      controller.signal,
    );

    expect(result).toMatchObject({
      status: "failure",
      error: { code: "aborted" },
      attempts: [{ outcome: "aborted" }],
      usage: { requests: 1 },
    });
  });

  it("stops without replay when the output callback fails", async () => {
    const result = await runStreamedAnswer(createHarness().streamSuccess(), () => {
      throw new Error("private callback failure");
    });

    expect(result).toMatchObject({
      status: "failure",
      error: { code: "stream_interrupted" },
      attempts: [{ outcome: "stream_interrupted" }],
      usage: { requests: 1 },
    });
  });
  });
}

defineRoleRunnerContract("Scripted", scriptedHarness);
defineRoleRunnerContract("Production", productionHarness);

describe("ScriptedRoleRunner scripting", () => {
  it("delivers scripted text deltas through the normalized callback", async () => {
    const onOutputDelta = vi.fn();
    const runner = scripted({
      status: "success",
      value: { answer: "hello" },
      deltas: ["hel", "lo"],
      attempts: [successfulAttempt],
    });

    const result = await runner.runStructured({
      role: "candidate",
      operation: "stream_contract_test",
      instructions: "Synthetic instructions",
      input: "Synthetic input",
      outputSchema: answerSchema,
      onOutputDelta,
    });

    expect(onOutputDelta.mock.calls).toEqual([["hel"], ["lo"]]);
    expect(result.status).toBe("success");
  });

  it("normalizes a scripted transport failure after delivering a delta", async () => {
    const runner = scripted({
      status: "failure",
      error: {
        code: "provider_unavailable",
        message: "The provider is temporarily unavailable.",
      },
      deltas: ["partial"],
      attempts: [{ ...successfulAttempt, outcome: "network_error" }],
    });

    const result = await runStreamedAnswer(runner, async () => undefined);

    expect(result).toMatchObject({
      status: "failure",
      error: { code: "stream_interrupted" },
      attempts: [{ outcome: "stream_interrupted" }],
      usage: { requests: 1 },
    });
  });

  it("can script an in-flight request that ends on abort", async () => {
    const controller = new AbortController();
    const runner = new ScriptedRoleRunner([
      {
        status: "await_abort",
        attempts: [successfulAttempt],
      },
    ]);

    const pending = runAnswer(runner, controller.signal);
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({
      status: "failure",
      error: { code: "aborted" },
      attempts: [{ outcome: "aborted" }],
      usage: { requests: 1 },
    });
  });
});
