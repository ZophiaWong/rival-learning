import { afterEach, describe, expect, it, vi } from "vitest";

import type { TimelineEvent } from "@/server/session-engine";

const { getApplication } = vi.hoisted(() => ({
  getApplication: vi.fn(),
}));

vi.mock("@/server/application", () => ({ getApplication }));

import { GET as streamSessionEvents } from "@/app/api/sessions/[id]/events/route";

const encoder = new TextDecoder();

function event(sequence: number): TimelineEvent {
  return {
    sequence,
    type: `event_${sequence}`,
    payload: { sequence },
    createdAt: "2026-08-28T08:00:00.000Z",
  };
}

afterEach(() => {
  vi.useRealTimers();
  getApplication.mockReset();
});

describe("Session timeline SSE route", () => {
  it("resumes after Last-Event-ID, streams later events, and closes on abort", async () => {
    vi.useFakeTimers();
    const events = [event(1), event(2)];
    getApplication.mockReturnValue({
      sessionEngine: {
        timeline: (_sessionId: string, afterSequence = 0) =>
          events.filter((item) => item.sequence > afterSequence),
      },
    });
    const abortController = new AbortController();
    const request = new Request("http://127.0.0.1:3000/api/sessions/session-1/events", {
      headers: { "last-event-id": "1" },
      signal: abortController.signal,
    });

    const response = await streamSessionEvents(request, {
      params: Promise.resolve({ id: "session-1" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const initial = await reader.read();
    const initialText = encoder.decode(initial.value);
    expect(initialText).toContain("id: 2");
    expect(initialText).not.toContain("id: 1\n");

    events.push(event(3));
    await vi.advanceTimersByTimeAsync(500);
    const update = await reader.read();
    const updateText = encoder.decode(update.value);
    expect(updateText).toContain("id: 3");
    expect(updateText).not.toContain("id: 2\n");

    abortController.abort();
    await vi.runAllTimersAsync();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });

  it("rejects an invalid Last-Event-ID", async () => {
    getApplication.mockReturnValue({
      sessionEngine: { timeline: vi.fn() },
    });
    const response = await streamSessionEvents(
      new Request("http://127.0.0.1:3000/api/sessions/session-1/events", {
        headers: { "last-event-id": "not-a-sequence" },
      }),
      { params: Promise.resolve({ id: "session-1" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Invalid HTTP request",
        fields: ["lastEventId"],
      },
    });
  });
});
