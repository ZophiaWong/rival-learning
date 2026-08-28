import { getApplication } from "@/server/application";
import { errorResponse } from "@/server/http";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const events = getApplication().sessionEngine.timeline(id);
    const body = events
      .map(
        (event) =>
          `id: ${event.sequence}\nevent: timeline\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
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
