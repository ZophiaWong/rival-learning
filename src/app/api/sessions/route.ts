import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import {
  errorResponse,
  parseIdempotencyKey,
  parseJsonRequest,
  sessionCreateRequestSchema,
} from "@/server/http";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ sessions: getApplication().sessionEngine.list() });
}

export async function POST(request: Request) {
  try {
    const body = await parseJsonRequest(request, sessionCreateRequestSchema);
    const idempotencyKey = parseIdempotencyKey(request);
    const result = await getApplication().sessionEngine.dispatch({
      type: "create_session",
      sessionId: body.sessionId,
      profileId: body.profileId,
      interviewLanguage: body.interviewLanguage,
      idempotencyKey,
    });
    return NextResponse.json(result, { status: result.status === "applied" ? 201 : 409 });
  } catch (error) {
    return errorResponse(error);
  }
}
