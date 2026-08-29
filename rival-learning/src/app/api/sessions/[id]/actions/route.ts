import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import {
  errorResponse,
  foundationActionRequestSchema,
  parseIdempotencyKey,
  parseJsonRequest,
} from "@/server/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await parseJsonRequest(request, foundationActionRequestSchema);
    const idempotencyKey = parseIdempotencyKey(request);
    const result = await getApplication().sessionEngine.dispatch({
      type: body.type,
      sessionId: id,
      idempotencyKey,
    });
    return NextResponse.json(result, { status: result.status === "rejected" ? 409 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
