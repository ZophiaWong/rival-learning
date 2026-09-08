import { AsyncLocalStorage } from "node:async_hooks";

// The engine owns the durable ledger; adapters reserve immediately before each request.
export interface RequestAccounting {
  reserve(): string | null;
  settle(id: string, inputTokens: number | null, outputTokens: number | null): void;
}
export const requestAccounting = new AsyncLocalStorage<RequestAccounting>();

export const budgetExhaustedResult = () => ({
  status: "failure" as const,
  error: { code: "budget_exhausted" as const, message: "Request budget exhausted. Extend it by 20 to continue." },
  attempts: [],
  usage: { requests: 0, inputTokens: 0, outputTokens: 0, usageComplete: true },
});
