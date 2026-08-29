import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import { errorResponse } from "@/server/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profile = getApplication().preparationProfiles.duplicate(id);
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
