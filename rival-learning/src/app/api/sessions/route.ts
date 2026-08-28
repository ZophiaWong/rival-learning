import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ sessions: getApplication().sessionEngine.list() });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { profileId?: string };
    if (!body.profileId) {
      return NextResponse.json(
        { error: { code: "profile_id_required", message: "profileId is required" } },
        { status: 400 },
      );
    }
    const sessionId = randomUUID();
    const result = await getApplication().sessionEngine.dispatch({
      type: "create_session",
      sessionId,
      profileId: body.profileId,
      idempotencyKey: request.headers.get("idempotency-key") ?? `create-${sessionId}`,
    });
    return NextResponse.json(result, { status: result.status === "applied" ? 201 : 409 });
  } catch (error) {
    return errorResponse(error);
  }
}
