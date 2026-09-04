import { describe, expect, it } from "vitest";

import { POST as createProfile } from "@/app/api/profiles/route";
import { POST as runSessionAction } from "@/app/api/sessions/[id]/actions/route";
import { POST as createSession } from "@/app/api/sessions/route";

const localUrl = "http://127.0.0.1:3000";

function jsonRequest(
  path: string,
  body: unknown,
  idempotencyKey?: string,
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (idempotencyKey !== undefined) {
    headers.set("idempotency-key", idempotencyKey);
  }
  return new Request(`${localUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function expectInvalidRequest(
  response: Response,
  fields: string[],
): Promise<void> {
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    error: {
      code: "invalid_request",
      message: "Invalid HTTP request",
      fields,
    },
  });
}

describe("HTTP runtime validation", () => {
  it("maps malformed JSON to a stable invalid_request response", async () => {
    const response = await createSession(
      new Request(`${localUrl}/api/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-1",
        },
        body: "{",
      }),
    );

    await expectInvalidRequest(response, ["body"]);
  });

  it("validates the Session creation identity and Profile reference", async () => {
    const response = await createSession(
      jsonRequest(
        "/api/sessions",
        { sessionId: "not-a-uuid", profileId: 42, interviewLanguage: "fr-FR" },
        "create-1",
      ),
    );

    await expectInvalidRequest(response, ["interviewLanguage", "profileId", "sessionId"]);
  });

  it.each([
    { name: "missing", key: undefined },
    { name: "invalid characters", key: "contains spaces" },
    { name: "too long", key: "a".repeat(129) },
  ])("rejects a $name Idempotency-Key", async ({ key }) => {
    const response = await createSession(
      jsonRequest(
        "/api/sessions",
        {
          sessionId: "9b4cd4fb-fc4b-4a01-8288-31c5cd678a2a",
          profileId: "profile-1",
          interviewLanguage: "zh-CN",
        },
        key,
      ),
    );

    await expectInvalidRequest(response, ["idempotencyKey"]);
  });

  it("validates the action discriminant at the route seam", async () => {
    const response = await runSessionAction(
      jsonRequest("/api/sessions/session-1/actions", { type: "auto" }, "action-1"),
      { params: Promise.resolve({ id: "session-1" }) },
    );

    await expectInvalidRequest(response, ["type"]);
  });

  it("validates PreparationProfile input before the domain Module", async () => {
    const response = await createProfile(
      jsonRequest("/api/profiles", {
        name: "Backend preparation",
        resume: 42,
        projectNotes: "",
        jobDescription: "Backend role",
        targetRole: "Backend Engineer",
        targetLevel: "Senior",
        repoPath: null,
      }),
    );

    await expectInvalidRequest(response, ["resume"]);
  });
});
