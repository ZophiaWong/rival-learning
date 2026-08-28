import { type NextRequest, NextResponse } from "next/server";

const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const stateChangingMethods = new Set(["POST", "PATCH", "DELETE"]);

function requestOrigin(protocol: string, host: string): string | null {
  try {
    return new URL(`${protocol}//${host}`).origin;
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function localRequestDenied(): NextResponse {
  return NextResponse.json(
    {
      error: {
        code: "local_request_required",
        message: "API requests must originate from this local application",
      },
    },
    { status: 403 },
  );
}

export function proxy(request: NextRequest): NextResponse {
  const host = request.headers.get("host");
  const expectedOrigin = host ? requestOrigin(request.nextUrl.protocol, host) : null;
  const hostname = expectedOrigin ? new URL(expectedOrigin).hostname.toLowerCase() : null;

  if (!hostname || !loopbackHostnames.has(hostname)) {
    return localRequestDenied();
  }

  if (stateChangingMethods.has(request.method.toUpperCase())) {
    const origin = request.headers.get("origin");
    if (!origin || normalizeOrigin(origin) !== expectedOrigin) {
      return localRequestDenied();
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
