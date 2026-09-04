import { NextResponse } from "next/server";
import { z } from "zod";

import {
  ProfileNotFoundError,
  ProfileValidationError,
  ProviderViewNotConfirmedError,
} from "@/server/preparation-profiles";
import { interviewLanguageSchema } from "@/server/core-loop/domain";

export const sessionCreateRequestSchema = z.strictObject({
  sessionId: z.uuid(),
  profileId: z.string().trim().min(1),
  interviewLanguage: interviewLanguageSchema,
});

export const foundationActionRequestSchema = z.strictObject({
  type: z.enum(["generate_plan", "start"]),
});

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export class InvalidHttpRequestError extends Error {
  readonly code = "invalid_request";

  constructor(readonly fields: string[]) {
    super("Invalid HTTP request");
    this.name = "InvalidHttpRequestError";
  }
}

function validationFields(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? "body")))]
    .filter(Boolean)
    .sort();
}

export async function parseJsonRequest<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new InvalidHttpRequestError(["body"]);
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new InvalidHttpRequestError(validationFields(result.error));
  }
  return result.data;
}

export function parseIdempotencyKey(request: Request): string {
  const result = idempotencyKeySchema.safeParse(request.headers.get("idempotency-key"));
  if (!result.success) {
    throw new InvalidHttpRequestError(["idempotencyKey"]);
  }
  return result.data;
}

export function parseLastEventId(request: Request): number {
  const value = request.headers.get("last-event-id");
  if (value === null) {
    return 0;
  }
  if (!/^\d+$/.test(value)) {
    throw new InvalidHttpRequestError(["lastEventId"]);
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new InvalidHttpRequestError(["lastEventId"]);
  }
  return sequence;
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof InvalidHttpRequestError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, fields: error.fields } },
      { status: 400 },
    );
  }
  if (error instanceof ProfileValidationError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, fields: error.fields } },
      { status: 400 },
    );
  }
  if (error instanceof ProfileNotFoundError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: 404 },
    );
  }
  if (error instanceof ProviderViewNotConfirmedError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: 409 },
    );
  }

  console.error("Unhandled server error");
  return NextResponse.json(
    { error: { code: "internal_error", message: "Unexpected local server error" } },
    { status: 500 },
  );
}
