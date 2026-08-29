import { NextResponse } from "next/server";

import { getApplication } from "@/server/application";
import { errorResponse } from "@/server/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const providerView = getApplication().preparationProfiles.previewProviderView(id);
    return NextResponse.json({ providerView });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const providerView = getApplication().preparationProfiles.confirmProviderView(id);
    return NextResponse.json({ providerView });
  } catch (error) {
    return errorResponse(error);
  }
}
