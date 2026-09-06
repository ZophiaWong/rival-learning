import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import {
  errorResponse,
  parseIdempotencyKey,
  parseJsonRequest,
  sessionActionRequestSchema,
} from "@/server/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await parseJsonRequest(request, sessionActionRequestSchema);
    const idempotencyKey = parseIdempotencyKey(request);
    const command =
      body.type === "submit_human_answer"
        ? { ...body, sessionId: id, idempotencyKey }
        : { type: body.type, sessionId: id, idempotencyKey };
    const result = await getApplication().sessionEngine.dispatch(command);
    return NextResponse.json(result, { status: result.status === "rejected" ? 409 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
