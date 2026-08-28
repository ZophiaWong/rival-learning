import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import { errorResponse } from "@/server/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { type?: "generate_plan" | "start" };
    if (body.type !== "generate_plan" && body.type !== "start") {
      return NextResponse.json(
        { error: { code: "invalid_action", message: "Unsupported foundation action" } },
        { status: 400 },
      );
    }
    const result = await getApplication().sessionEngine.dispatch({
      type: body.type,
      sessionId: id,
      idempotencyKey: request.headers.get("idempotency-key") ?? randomUUID(),
    });
    return NextResponse.json(result, { status: result.status === "rejected" ? 409 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
