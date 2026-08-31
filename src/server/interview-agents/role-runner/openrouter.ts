import {
  Agent,
  ModelBehaviorError,
  ModelTimeoutError,
  OpenAIProvider,
  Runner,
  type ModelResponse,
} from "@openai/agents";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import { z } from "zod";

import {
  getProviderConfigurationStatus,
  type RoleName,
  type ServerConfig,
} from "@/server/config/server-config";

import {
  aggregateRoleRunUsage,
  type ModelAttempt,
  type ModelAttemptOutcome,
  type RoleRunErrorCode,
  type RoleRunRequest,
  type RoleRunResult,
  type RoleRunner,
} from "./index";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

interface OpenAIClientOptions {
  apiKey: string;
  baseURL: typeof OPENROUTER_BASE_URL;
  maxRetries: 0;
}

export interface OpenRouterRoleRunnerDependencies {
  createClient?: (options: OpenAIClientOptions) => OpenAI;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  attemptTimeoutMs?: number;
}

interface ConfiguredRoleBinding {
  status: "configured";
  model: string;
  runner: Runner;
}

interface UnavailableRoleBinding {
  status: "missing" | "unsupported";
}

type RoleBinding = ConfiguredRoleBinding | UnavailableRoleBinding;

function emptyUsage() {
  return aggregateRoleRunUsage([]);
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function readRawToken(
  rawUsage: Record<string, unknown> | undefined,
  snakeCaseKey: string,
  camelCaseKey: string,
): number | null {
  const value = rawUsage?.[snakeCaseKey] ?? rawUsage?.[camelCaseKey];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

interface ClassifiedError {
  code: RoleRunErrorCode;
  message: string;
  outcome: ModelAttemptOutcome;
  httpStatus: number | null;
  requestId: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
}

class OutputCallbackError extends Error {
  constructor() {
    super("Output callback failed");
    this.name = "OutputCallbackError";
  }
}

function parseRetryAfter(headers: Headers | undefined): number | null {
  const value = headers?.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function classifyError(
  error: unknown,
  signal?: AbortSignal,
  schemaFailureConfirmed = false,
): ClassifiedError {
  if (error instanceof OutputCallbackError) {
    return {
      code: "stream_interrupted",
      message: "The streamed model output was interrupted.",
      outcome: "stream_interrupted",
      httpStatus: null,
      requestId: null,
      retryable: false,
      retryAfterMs: null,
    };
  }
  if (
    signal?.aborted ||
    error instanceof APIUserAbortError ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return {
      code: "aborted",
      message: "The model request was aborted.",
      outcome: "aborted",
      httpStatus: null,
      requestId: null,
      retryable: false,
      retryAfterMs: null,
    };
  }
  if (error instanceof ModelTimeoutError || error instanceof APIConnectionTimeoutError) {
    return {
      code: "provider_timeout",
      message: "The provider request timed out.",
      outcome: "timeout",
      httpStatus: null,
      requestId: null,
      retryable: true,
      retryAfterMs: null,
    };
  }
  if (error instanceof APIError && error.status !== undefined) {
    const status = error.status;
    const shared = {
      httpStatus: status,
      requestId: error.requestID ?? null,
      retryAfterMs: parseRetryAfter(error.headers),
    };
    if (status === 401) {
      return {
        ...shared,
        code: "provider_auth_failed",
        message: "The provider rejected the configured credentials.",
        outcome: "http_error",
        retryable: false,
      };
    }
    if (status === 402) {
      return {
        ...shared,
        code: "provider_quota_exhausted",
        message: "The provider quota is exhausted.",
        outcome: "http_error",
        retryable: false,
      };
    }
    if (status === 403) {
      return {
        ...shared,
        code: "provider_rejected",
        message: "The provider rejected the request.",
        outcome: "http_error",
        retryable: false,
      };
    }
    if (status === 404) {
      return {
        ...shared,
        code: "model_not_found",
        message: "The configured model was not found.",
        outcome: "http_error",
        retryable: false,
      };
    }
    if (status === 408) {
      return {
        ...shared,
        code: "provider_timeout",
        message: "The provider request timed out.",
        outcome: "timeout",
        retryable: true,
      };
    }
    if (status === 429) {
      return {
        ...shared,
        code: "provider_rate_limited",
        message: "The provider rate limit was reached.",
        outcome: "http_error",
        retryable: true,
      };
    }
    if (status === 409 || status >= 500) {
      return {
        ...shared,
        code: "provider_unavailable",
        message: "The provider is temporarily unavailable.",
        outcome: "http_error",
        retryable: true,
      };
    }
    return {
      ...shared,
      code: "provider_rejected",
      message: "The provider rejected the request.",
      outcome: "http_error",
      retryable: false,
    };
  }
  if (error instanceof APIConnectionError) {
    return {
      code: "provider_unavailable",
      message: "The provider is temporarily unavailable.",
      outcome: "network_error",
      httpStatus: null,
      requestId: null,
      retryable: true,
      retryAfterMs: null,
    };
  }
  if (error instanceof ModelBehaviorError && schemaFailureConfirmed) {
    return {
      code: "schema_invalid",
      message: "The model response did not match the required schema.",
      outcome: "schema_invalid",
      httpStatus: 200,
      requestId: error.state?._modelResponses.at(-1)?.requestId ?? null,
      retryable: true,
      retryAfterMs: null,
    };
  }
  if (error instanceof ModelBehaviorError) {
    return {
      code: "internal_error",
      message: "The model request failed.",
      outcome: "internal_error",
      httpStatus: null,
      requestId: error.state?._modelResponses.at(-1)?.requestId ?? null,
      retryable: false,
      retryAfterMs: null,
    };
  }
  return {
    code: "internal_error",
    message: "The model request failed.",
    outcome: "internal_error",
    httpStatus: null,
    requestId: null,
    retryable: false,
    retryAfterMs: null,
  };
}

function lastResponseFromError(error: unknown): ModelResponse | undefined {
  return error instanceof ModelBehaviorError
    ? error.state?._modelResponses.at(-1)
    : undefined;
}

function extractModelText(response: ModelResponse | undefined): string | null {
  for (const item of response?.output ?? []) {
    if (!("content" in item) || !Array.isArray(item.content)) continue;
    const text = item.content
      .filter(
        (content): content is { type: "output_text"; text: string } =>
          typeof content === "object" &&
          content !== null &&
          "type" in content &&
          content.type === "output_text" &&
          "text" in content &&
          typeof content.text === "string",
      )
      .map((content) => content.text)
      .join("");
    if (text) return text;
  }
  return null;
}

function formatZodIssues(error: z.ZodError): string {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? `$.${issue.path.map(String).join(".")}` : "$";
    const expected = "expected" in issue ? String(issue.expected) : issue.code;
    return `- ${path}: expected ${expected}`;
  });
  return `\n\nSchema correction for this fresh attempt:\n${issues.join("\n")}`;
}

function schemaCorrectionFromResponse<T>(
  response: ModelResponse | undefined,
  outputSchema: z.ZodType<T>,
): string {
  const rawText = extractModelText(response);
  if (!rawText) {
    return "\n\nSchema correction for this fresh attempt:\n- $: expected valid JSON matching the response schema";
  }
  try {
    const parsedJson: unknown = JSON.parse(rawText);
    const parsed = outputSchema.safeParse(parsedJson);
    return parsed.success
      ? "\n\nSchema correction for this fresh attempt:\n- $: expected exact conformance to the response schema"
      : formatZodIssues(parsed.error);
  } catch {
    return "\n\nSchema correction for this fresh attempt:\n- $: expected valid JSON matching the response schema";
  }
}

export class OpenRouterRoleRunner implements RoleRunner {
  private readonly bindings: Record<RoleName, RoleBinding>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly attemptTimeoutMs: number;

  constructor(config: ServerConfig, dependencies: OpenRouterRoleRunnerDependencies = {}) {
    const configurationStatus = getProviderConfigurationStatus(config);
    const createClient =
      dependencies.createClient ?? ((options: OpenAIClientOptions) => new OpenAI(options));
    this.now = dependencies.now ?? (() => performance.now());
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.attemptTimeoutMs = dependencies.attemptTimeoutMs ?? 90_000;

    this.bindings = Object.fromEntries(
      (Object.keys(config.providers) as RoleName[]).map((role) => {
        const status = configurationStatus[role];
        if (status.status !== "configured") {
          return [role, { status: status.status } satisfies UnavailableRoleBinding];
        }

        const roleConfig = config.providers[role];
        const client = createClient({
          apiKey: roleConfig.apiKey!,
          baseURL: OPENROUTER_BASE_URL,
          maxRetries: 0,
        });
        const provider = new OpenAIProvider({
          openAIClient: client,
          useResponses: false,
          strictFeatureValidation: true,
        });
        const runner = new Runner({
          modelProvider: provider,
          tracingDisabled: true,
          traceIncludeSensitiveData: false,
        });

        return [
          role,
          {
            status: "configured",
            model: roleConfig.model!,
            runner,
          } satisfies ConfiguredRoleBinding,
        ];
      }),
    ) as Record<RoleName, RoleBinding>;
  }

  async runStructured<T>(request: RoleRunRequest<T>): Promise<RoleRunResult<T>> {
    const binding = this.bindings[request.role];
    if (binding.status === "missing") {
      return {
        status: "failure",
        error: {
          code: "provider_not_configured",
          message: `The ${request.role} provider is not configured.`,
        },
        attempts: [],
        usage: emptyUsage(),
      };
    }
    if (binding.status === "unsupported") {
      return {
        status: "failure",
        error: {
          code: "provider_unsupported",
          message: `The ${request.role} provider is not supported.`,
        },
        attempts: [],
        usage: emptyUsage(),
      };
    }
    if (request.signal?.aborted) {
      return {
        status: "failure",
        error: { code: "aborted", message: "The model request was aborted." },
        attempts: [],
        usage: emptyUsage(),
      };
    }
    const configuredBinding = binding as ConfiguredRoleBinding;

    const attempts: ModelAttempt[] = [];
    let schemaCorrection = "";
    let outputDelivered = false;
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const startedAt = this.now();
      let invalidOutputResponse: ModelResponse | undefined;
      let streamedResponse: ModelResponse | undefined;
      const attemptController = new AbortController();
      const attemptSignal = request.signal
        ? AbortSignal.any([request.signal, attemptController.signal])
        : attemptController.signal;
      try {
        const agent = new Agent({
          name: `rival-learning-${request.role}`,
          model: configuredBinding.model,
          instructions: `${request.instructions}${schemaCorrection}`,
          outputType: request.outputSchema,
          modelSettings: {
            store: false,
            preserveRawUsage: true,
            timeoutMs: this.attemptTimeoutMs,
            retry: { maxRetries: 0 },
            providerData: {
              provider: {
                require_parameters: true,
                data_collection: "deny",
              },
              metadata: {
                app: "rival-learning",
                role: request.role,
                operation: request.operation,
              },
            },
          },
        });
        const errorHandlers = {
          invalidFinalOutput({ runData }: { runData: { rawResponses: ModelResponse[] } }) {
            invalidOutputResponse = runData.rawResponses.at(-1);
          },
        };
        let finalOutput: T | undefined;
        if (request.onOutputDelta) {
          const stream = await configuredBinding.runner.run(agent, request.input, {
            maxTurns: 1,
            signal: attemptSignal,
            stream: true,
            errorHandlers,
          });
          try {
            for await (const delta of stream.toTextStream()) {
              try {
                await request.onOutputDelta(delta);
                outputDelivered = true;
              } catch {
                attemptController.abort();
                throw new OutputCallbackError();
              }
              if (request.signal?.aborted) throw request.signal.reason;
            }
            await stream.completed;
            if (stream.error) throw stream.error;
            finalOutput = stream.finalOutput;
            streamedResponse = stream.rawResponses.at(-1);
          } catch (error) {
            streamedResponse = stream.rawResponses.at(-1);
            throw error;
          }
        } else {
          const result = await configuredBinding.runner.run(agent, request.input, {
            maxTurns: 1,
            signal: attemptSignal,
            errorHandlers,
          });
          finalOutput = result.finalOutput;
          streamedResponse = result.rawResponses.at(-1);
        }

        if (finalOutput === undefined) {
          const attempt: ModelAttempt = {
            attempt: attemptNumber,
            providerId: "openrouter",
            model: configuredBinding.model,
            outcome: "internal_error",
            httpStatus: 200,
            requestId: streamedResponse?.requestId ?? null,
            durationMs: Math.max(0, this.now() - startedAt),
            inputTokens: readRawToken(
              streamedResponse?.rawUsage,
              "prompt_tokens",
              "inputTokens",
            ),
            outputTokens: readRawToken(
              streamedResponse?.rawUsage,
              "completion_tokens",
              "outputTokens",
            ),
          };
          attempts.push(attempt);
          return {
            status: "failure",
            error: {
              code: "internal_error",
              message: "The model request failed.",
            },
            attempts,
            usage: aggregateRoleRunUsage(attempts),
          };
        }

        const response = streamedResponse;
        const attempt: ModelAttempt = {
          attempt: attemptNumber,
          providerId: "openrouter",
          model: configuredBinding.model,
          outcome: "succeeded",
          httpStatus: 200,
          requestId: response?.requestId ?? null,
          durationMs: Math.max(0, this.now() - startedAt),
          inputTokens: readRawToken(response?.rawUsage, "prompt_tokens", "inputTokens"),
          outputTokens: readRawToken(
            response?.rawUsage,
            "completion_tokens",
            "outputTokens",
          ),
        };
        attempts.push(attempt);
        return {
          status: "success",
          value: finalOutput,
          attempts,
          usage: aggregateRoleRunUsage(attempts),
        };
      } catch (error) {
        let classified = classifyError(
          error,
          request.signal,
          invalidOutputResponse !== undefined,
        );
        const response =
          lastResponseFromError(error) ?? invalidOutputResponse ?? streamedResponse;
        if (
          outputDelivered &&
          classified.code !== "aborted" &&
          classified.code !== "stream_interrupted"
        ) {
          classified = {
            code: "stream_interrupted",
            message: "The streamed model output was interrupted.",
            outcome: "stream_interrupted",
            httpStatus: classified.httpStatus,
            requestId: classified.requestId,
            retryable: false,
            retryAfterMs: null,
          };
        }
        const attempt: ModelAttempt = {
          attempt: attemptNumber,
          providerId: "openrouter",
          model: configuredBinding.model,
          outcome: classified.outcome,
          httpStatus: classified.httpStatus,
          requestId: classified.requestId ?? response?.requestId ?? null,
          durationMs: Math.max(0, this.now() - startedAt),
          inputTokens: readRawToken(response?.rawUsage, "prompt_tokens", "inputTokens"),
          outputTokens: readRawToken(
            response?.rawUsage,
            "completion_tokens",
            "outputTokens",
          ),
        };
        attempts.push(attempt);

        if (classified.retryable && attemptNumber < 3) {
          if (classified.code === "schema_invalid") {
            schemaCorrection = schemaCorrectionFromResponse(response, request.outputSchema);
          }
          const baseDelay = attemptNumber === 1 ? 500 : 1000;
          const delay = Math.min(
            10_000,
            Math.max(baseDelay, classified.retryAfterMs ?? 0),
          );
          try {
            await this.sleep(delay, request.signal);
          } catch {
            return {
              status: "failure",
              error: { code: "aborted", message: "The model request was aborted." },
              attempts,
              usage: aggregateRoleRunUsage(attempts),
            };
          }
          continue;
        }

        return {
          status: "failure",
          error: { code: classified.code, message: classified.message },
          attempts,
          usage: aggregateRoleRunUsage(attempts),
        };
      }
    }

    return {
      status: "failure",
      error: { code: "internal_error", message: "The model request failed." },
      attempts,
      usage: aggregateRoleRunUsage(attempts),
    };
  }
}
