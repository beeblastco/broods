/**
 * Only what an agent task needs: core's harness route, with the account and
 * media handlers left out. Bundled on its own (`bun build.ts ./task-entry.ts
 * ./dist-task`) to see how much of core's 20.7 MB an agent run pulls in.
 */

import "./install-bun-global.ts";
import { installScriptedModel } from "./scripted-model.ts";
import { createRoute } from "../../apps/core/src/server.ts";
import { handler as harnessHandler } from "../../apps/core/src/harness/handler.ts";
import { drainInFlight } from "../../apps/core/src/shared/in-flight.ts";

if (process.env.BENCH_SCRIPTED_MODEL === "1") installScriptedModel();

function notInTaskBundle(): Promise<Response> {
  return Promise.resolve(
    Response.json({ error: "not in the task bundle" }, { status: 404 }),
  );
}

const route = createRoute(
  {
    accountHandler: notInTaskBundle,
    handleMediaRequest: notInTaskBundle,
    harnessHandler: harnessHandler,
    routesToMedia: (): boolean => false,
  },
  10 * 60 * 1000,
);

export default {
  fetch: async function (
    request: Request,
    _env: unknown,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    const response = await route(
      request,
      request.headers.get("cf-connecting-ip") ?? undefined,
    );
    if (!response.body) {
      ctx.waitUntil(drainInFlight());

      return response;
    }
    const { readable, writable } = new TransformStream<
      Uint8Array,
      Uint8Array
    >();
    ctx.waitUntil(
      response.body.pipeTo(writable).then(drainInFlight, drainInFlight),
    );

    return new Response(readable, response);
  },
};
