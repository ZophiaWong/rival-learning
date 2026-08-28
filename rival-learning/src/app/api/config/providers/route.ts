import { NextResponse } from "next/server";

import { getSafeProviderConfigurationStatus } from "@/server/config";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getSafeProviderConfigurationStatus());
}
