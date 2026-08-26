/**
 * HTTP endpoint for `broods project list` and `broods project delete`.
 *
 * Project management spans every stage of a project, so it authenticates with a
 * `broods login` token rather than a stage-scoped deploy key, exactly as the
 * stage endpoint does.
 */

import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { sha256Hex } from "./model/accountSecrets";

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
        { error: "Project commands require a `broods login` token" },
        401,
      );
    }

    if (req.method === "GET") {
      const projects = await ctx.runQuery(internal.cliProjects.listByAccount, {
        accountId: resolved.accountId,
      });

      return projects
        ? json({ projects: projects })
        : json({ error: "Account is not active" }, 403);
    }

    if (req.method === "DELETE") {
      const projectId =
        new URL(req.url).searchParams.get("projectId")?.trim() ?? "";
      if (!projectId) {
        return json({ error: "A projectId query parameter is required" }, 400);
      }
      const deleted = await ctx.runMutation(
        internal.cliProjects.removeByAccount,
        {
          accountId: resolved.accountId,
          authId: resolved.authId,
          projectId: projectId,
        },
      );
      if (deleted === "forbidden") {
        return json(
          { error: "Deleting a project requires an org admin role" },
          403,
        );
      }

      return deleted
        ? json({ deleted: deleted })
        : json({ error: "Project was not found" }, 404);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("CLI project request failed", error);
    if (error instanceof SyntaxError || error instanceof URIError) {
      return json({ error: "Request body or path is invalid" }, 400);
    }
    const detail = error instanceof Error ? error.message : "";

    return json(
      {
        error: "Project request failed",
        ...(detail ? { detail: detail } : {}),
      },
      500,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}
