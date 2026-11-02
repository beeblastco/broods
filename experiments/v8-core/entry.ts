/**
 * Core's real router and handlers as a Worker on self-hosted workerd; Bun APIs from bun-shim.ts.
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
    (globalThis as { __slimServing?: boolean }).__slimServing = true;
    const response = await route(
      request,
      request.headers.get("cf-connecting-ip") ?? undefined,
    );
    // workerd cancels I/O once the response is done, so wait for the body, then core's in-flight
    // work (much of it starts only as a streamed body ends).
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
