import { getApplication } from "@/server/application";
import { errorResponse, parseLastEventId } from "@/server/http";
import type { TimelineEvent } from "@/server/session-engine";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const pollIntervalMs = 500;
const heartbeatIntervalMs = 15_000;

function serializeEvent(event: TimelineEvent): string {
  return `id: ${event.sequence}\nevent: timeline\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const sessionEngine = getApplication().sessionEngine;
    let cursor = parseLastEventId(request);
    const initialEvents = sessionEngine.timeline(id, cursor);
    const textEncoder = new TextEncoder();
    let cleanup: () => void = () => undefined;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;

        const enqueueEvents = (events: TimelineEvent[]) => {
          for (const event of events) {
            if (event.sequence <= cursor) continue;
            controller.enqueue(textEncoder.encode(serializeEvent(event)));
            cursor = event.sequence;
          }
        };

        const poll = () => {
          if (closed) return;
          try {
            enqueueEvents(sessionEngine.timeline(id, cursor));
          } catch (error) {
            stop();
            controller.error(error);
          }
        };

        const pollTimer = setInterval(poll, pollIntervalMs);
        const heartbeatTimer = setInterval(() => {
          if (!closed) {
            controller.enqueue(textEncoder.encode(": keep-alive\n\n"));
          }
        }, heartbeatIntervalMs);

        const stop = () => {
          if (closed) return;
          closed = true;
          clearInterval(pollTimer);
          clearInterval(heartbeatTimer);
          request.signal.removeEventListener("abort", abort);
        };
        const abort = () => {
          stop();
          controller.close();
        };
        cleanup = stop;
        request.signal.addEventListener("abort", abort, { once: true });
        enqueueEvents(initialEvents);
        if (request.signal.aborted) {
          abort();
        }
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
