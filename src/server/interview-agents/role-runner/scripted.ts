import {
  abortedRoleRunResult,
  aggregateRoleRunUsage,
  type ModelAttempt,
  type RoleRunErrorCode,
  type RoleRunner,
  type RoleRunUsage,
} from "./index";

interface ScriptedRoleRunStepBase {
  attempts?: ModelAttempt[];
  usage?: RoleRunUsage;
  deltas?: string[];
}

export type ScriptedRoleRunStep =
  | (ScriptedRoleRunStepBase & {
      status: "success";
      value: unknown;
    })
  | (ScriptedRoleRunStepBase & {
      status: "failure";
      error: {
        code: RoleRunErrorCode;
        message: string;
      };
    })
  | (ScriptedRoleRunStepBase & {
      status: "await_abort";
    });

export class ScriptedRoleRunner implements RoleRunner {
  private readonly steps: ScriptedRoleRunStep[];

  constructor(steps: ScriptedRoleRunStep[]) {
    this.steps = [...steps];
  }

  async runStructured<T>(request: Parameters<RoleRunner["runStructured"]>[0]) {
    if (request.signal?.aborted) {
      return abortedRoleRunResult();
    }

    const step = this.steps.shift();
    if (!step) {
      return {
        status: "failure" as const,
        error: {
          code: "internal_error" as const,
          message: "No scripted role run result is available.",
        },
        attempts: [],
        usage: aggregateRoleRunUsage([]),
      };
    }

    const attempts = [...(step.attempts ?? [])];
    const usage = step.usage ?? aggregateRoleRunUsage(attempts);
    let outputDelivered = false;

    if (step.status === "await_abort") {
      if (!request.signal) {
        return {
          status: "failure" as const,
          error: {
            code: "internal_error" as const,
            message: "The scripted abort step requires an AbortSignal.",
          },
          attempts,
          usage,
        };
      }
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        status: "failure" as const,
        error: { code: "aborted" as const, message: "The model request was aborted." },
        attempts: attempts.map((attempt, index) =>
          index === attempts.length - 1
            ? { ...attempt, outcome: "aborted" as const }
            : attempt,
        ),
        usage,
      };
    }

    for (const delta of step.deltas ?? []) {
      if (request.signal?.aborted) {
        return abortedRoleRunResult();
      }
      try {
        if (request.onOutputDelta) {
          await request.onOutputDelta(delta);
          outputDelivered = true;
        }
        if (request.signal?.aborted) {
          return {
            status: "failure" as const,
            error: { code: "aborted" as const, message: "The model request was aborted." },
            attempts: attempts.map((attempt, index) =>
              index === attempts.length - 1
                ? { ...attempt, outcome: "aborted" as const }
                : attempt,
            ),
            usage,
          };
        }
      } catch {
        return {
          status: "failure" as const,
          error: {
            code: "stream_interrupted" as const,
            message: "The streamed model output was interrupted.",
          },
          attempts: attempts.map((attempt, index) =>
            index === attempts.length - 1
              ? { ...attempt, outcome: "stream_interrupted" as const }
              : attempt,
          ),
          usage,
        };
      }
    }

    if (step.status === "failure") {
      if (outputDelivered && step.error.code !== "aborted") {
        return {
          status: "failure" as const,
          error: {
            code: "stream_interrupted" as const,
            message: "The streamed model output was interrupted.",
          },
          attempts: attempts.map((attempt, index) =>
            index === attempts.length - 1
              ? { ...attempt, outcome: "stream_interrupted" as const }
              : attempt,
          ),
          usage,
        };
      }
      return { ...step, attempts, usage };
    }

    const parsed = request.outputSchema.safeParse(step.value);
    if (!parsed.success) {
      const code: "stream_interrupted" | "schema_invalid" = outputDelivered
        ? "stream_interrupted"
        : "schema_invalid";
      return {
        status: "failure" as const,
        error: {
          code,
          message: outputDelivered
            ? "The streamed model output was interrupted."
            : "The model response did not match the required schema.",
        },
        attempts: attempts.map((attempt, index) =>
          index === attempts.length - 1
            ? { ...attempt, outcome: code }
            : attempt,
        ),
        usage,
      };
    }

    return {
      status: "success" as const,
      value: parsed.data as T,
      attempts,
      usage,
    };
  }
}
