/**
 * Core's real request router and handlers, run as a Worker on self-hosted
 * workerd instead of a long-lived Bun process. Core needed two small patches
 * (cache-digest.ts, http.ts); the Bun APIs it touches are shimmed (bun-shim.ts).
 */

import "./install-bun-global.ts";
import { installScriptedModel } from "./scripted-model.ts";
import { createRoute } from "../../apps/core/src/server.ts";
import { handler as accountHandler } from "../../apps/core/src/accounts/handler.ts";
import {
  handleMediaRequest,
  routesToMedia,
} from "../../apps/core/src/media.ts";
import { handler as harnessHandler } from "../../apps/core/src/harness/handler.ts";
import { drainInFlight } from "../../apps/core/src/shared/in-flight.ts";

if (process.env.BENCH_SCRIPTED_MODEL === "1") installScriptedModel();

const route = createRoute(
  {
    accountHandler: accountHandler,
    handleMediaRequest: handleMediaRequest,
    harnessHandler: harnessHandler,
    routesToMedia: routesToMedia,
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
    // Core's post-response work (usage rows, async runs, subagent hand-backs)
    // lives in its own in-flight set, and much of it starts only as a streamed
    // body ends; workerd cancels a request's I/O once the response is done
    // unless told to wait. So the request waits for its body, then for the set.
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
