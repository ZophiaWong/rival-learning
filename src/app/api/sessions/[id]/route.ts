import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import { errorResponse } from "@/server/http";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const application = getApplication();
    return NextResponse.json({
      session: application.sessionEngine.get(id),
      timeline: application.sessionEngine.timeline(id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
