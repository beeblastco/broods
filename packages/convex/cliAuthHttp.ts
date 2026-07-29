/**
 * HTTP exchange endpoint for WorkOS-backed CLI login codes.
 */

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const exchange = httpAction(async (ctx, req) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: { code?: unknown };
  try {
    body = (await req.json()) as { code?: unknown };
  } catch {

    return json({ error: "Request body must be valid JSON" }, 400);
  }

  if (typeof body.code !== "string" || !body.code.trim()) {

    return json({ error: "Request body must include code" }, 400);
  }

  try {
    const result: Record<string, unknown> = await ctx.runMutation(
      internal.cliAuth.exchangeLoginCode,
      {
        code: body.code,
      },
    );

    return json(result);
  } catch (error) {
    console.error("CLI login exchange failed", error);
    if (
      error instanceof Error &&
      error.message.includes("CLI login code is invalid or expired")
    ) {

      return json({ error: "Login code is invalid or expired" }, 400);
    }

    return json({ error: "Login exchange failed" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}
