import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

function localRequest(
  path: string,
  options: { method?: string; host?: string; origin?: string } = {},
): NextRequest {
  const host = options.host ?? "127.0.0.1:3000";
  const headers = new Headers({ host });
  if (options.origin) {
    headers.set("origin", options.origin);
  }
  return new NextRequest(`http://${host}${path}`, {
    method: options.method ?? "GET",
    headers,
  });
}

describe("local API request guard", () => {
  it.each(["127.0.0.1:3000", "localhost:3000", "[::1]:3000"])(
    "accepts a loopback Host (%s)",
    (host) => {
      const response = proxy(localRequest("/api/profiles", { host }));

      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it("rejects a non-loopback Host used by a DNS-rebinding origin", async () => {
    const response = proxy(
      localRequest("/api/profiles", {
        host: "attacker.example:3000",
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "local_request_required",
        message: "API requests must originate from this local application",
      },
    });
  });

  it("accepts a state-changing request with a same-origin Origin", () => {
    const response = proxy(
      localRequest("/api/sessions", {
        method: "POST",
        origin: "http://127.0.0.1:3000",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    { name: "missing", origin: undefined },
    { name: "cross-origin", origin: "https://attacker.example" },
    { name: "malformed", origin: "not a valid origin" },
  ])("rejects a state-changing request with a $name Origin", async ({ origin }) => {
    const response = proxy(
      localRequest("/api/sessions", {
        method: "POST",
        origin,
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "local_request_required" },
    });
  });
});
