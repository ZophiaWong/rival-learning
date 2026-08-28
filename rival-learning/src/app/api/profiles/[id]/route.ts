import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import { errorResponse } from "@/server/http";
import type { PreparationProfileInput } from "@/server/preparation-profiles";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profiles = getApplication().preparationProfiles;
    return NextResponse.json({
      profile: profiles.get(id),
      deletionImpact: profiles.getDeletionImpact(id),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const input = (await request.json()) as PreparationProfileInput;
    const profile = getApplication().preparationProfiles.update(id, input);
    return NextResponse.json({ profile });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const profiles = getApplication().preparationProfiles;
    const deletionImpact = profiles.getDeletionImpact(id);
    profiles.delete(id);
    return NextResponse.json({ deleted: true, deletionImpact });
  } catch (error) {
    return errorResponse(error);
  }
}
