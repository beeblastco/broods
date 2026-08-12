/**
 * HTTP endpoint for `broods stage list` and `broods stage create`.
 *
 * Stage management spans every stage of a project, so it authenticates
 * with a `broods login` token rather than a stage-scoped deploy key.
 */

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const handle = httpAction(async (ctx, req) => {
  try {
    const auth = await bearerAuth(req);
    if (!auth) {
      return json({ error: "Authorization Bearer token is required" }, 401);
    }

    const resolved = await ctx.runMutation(internal.cliAuth.resolveCliToken, {
      tokenHash: auth.secretHash,
    });
    if (!resolved) {
      return json(
        { error: "Stage commands require a `broods login` token" },
        401,
      );
    }

    if (req.method === "GET") {
      const project = new URL(req.url).searchParams.get("project") ?? "";
      if (!project.trim()) {
        return json({ error: "A project query parameter is required" }, 400);
      }
      const stages = await ctx.runQuery(internal.cliStages.listByAccount, {
        accountId: resolved.accountId,
        project: project,
      });

      return stages
        ? json({ stages: stages })
        : json({ error: `Project ${project} was not found` }, 404);
    }

    if (req.method === "POST") {
      const body = (await req.json()) as {
        project?: unknown;
        name?: unknown;
        from?: unknown;
      };
      if (typeof body.project !== "string" || !body.project.trim()) {
        return json({ error: "Request body must include a project" }, 400);
      }
      if (typeof body.name !== "string" || !body.name.trim()) {
        return json({ error: "Request body must include a name" }, 400);
      }
      if (body.from !== undefined && typeof body.from !== "string") {
        return json({ error: "`from` must be a stage name" }, 400);
      }
      const created = await ctx.runMutation(
        internal.cliStages.createByAccount,
        {
          accountId: resolved.accountId,
          project: body.project,
          name: body.name,
          ...(body.from ? { duplicateFrom: body.from } : {}),
        },
      );

      return created
        ? json(created)
        : json({ error: `Project ${body.project} was not found` }, 404);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("CLI stage request failed", error);
    if (error instanceof SyntaxError) {
      return json({ error: "Request body must be valid JSON" }, 400);
    }

    return json(
      {
        error: error instanceof Error ? error.message : "Stage request failed",
      },
      400,
    );
  }
});

async function bearerAuth(
  req: Request,
): Promise<{ secretHash: string } | null> {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }

  return {
    secretHash: await sha256Hex(match[1]),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}
