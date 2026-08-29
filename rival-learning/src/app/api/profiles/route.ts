import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import { errorResponse, parseJsonRequest } from "@/server/http";
import { preparationProfileInputSchema } from "@/server/preparation-profiles";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ profiles: getApplication().preparationProfiles.list() });
}

export async function POST(request: Request) {
  try {
    const input = await parseJsonRequest(request, preparationProfileInputSchema);
    const profile = getApplication().preparationProfiles.create(input);
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
