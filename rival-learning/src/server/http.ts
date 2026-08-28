import { NextResponse } from "next/server";

import {
  ProfileNotFoundError,
  ProfileValidationError,
  ProviderViewNotConfirmedError,
} from "@/server/preparation-profiles";

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof ProfileValidationError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message, fields: error.fields } },
      { status: 400 },
    );
  }
  if (error instanceof ProfileNotFoundError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: 404 },
    );
  }
  if (error instanceof ProviderViewNotConfirmedError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: 409 },
    );
  }

  console.error("Unhandled server error", error instanceof Error ? error.name : "UnknownError");
  return NextResponse.json(
    { error: { code: "internal_error", message: "Unexpected local server error" } },
    { status: 500 },
  );
}
