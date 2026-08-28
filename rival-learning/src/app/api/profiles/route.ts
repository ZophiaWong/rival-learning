import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import { errorResponse } from "@/server/http";
import type { PreparationProfileInput } from "@/server/preparation-profiles";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ profiles: getApplication().preparationProfiles.list() });
}

export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PreparationProfileInput;
    const profile = getApplication().preparationProfiles.create(input);
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
