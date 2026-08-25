/**
 * The http tool tier: instead of executing bundle bytes, POSTs the
 * model-produced input to the https endpoint stored on the row and yields the
 * response as the tool result. Header values may carry `${NAME}` references,
 * resolved against the same merged per-tool config a bundle would see as
 * ctx.config — so secret header values never live in the tool row. Egress is
 * guarded by the same pinned-fetch bridge bundles get, so a stored endpoint
 * cannot be repointed at an internal address at call time. Dispatch lives in
 * executor.ts; payload/frame protocol in ./payload.ts.
 */

import {
  guardedFetch,
} from "../isolate/runner/pinned-fetch.mjs";
import { isPlainObject } from "../../shared/object.ts";
import {
  mergeToolConfig,
  type ExecuteAccountToolOptions,
} from "./payload.ts";

// Same bound the bundle tiers effectively run under (Lambda request timeout).
const ENDPOINT_TIMEOUT_MS = 30_000;
// Uppercase env-var shape, matching what Convex substitutes into the encrypted
// agent config. An unmatched reference fails the call rather than transmitting
// the literal to a third party.
const ENV_REF_PATTERN = /\$\{([A-Z][A-Z0-9_]*)\}/g;
// Error bodies are the user's own service speaking — keep enough to debug by.
const ERROR_BODY_EXCERPT_CHARS = 500;

/**
 * Streams one endpoint call. A non-streaming tier like every runner: it yields
 * exactly once, with the parsed response body.
 */
export async function* streamAccountToolToEndpoint(
  options: ExecuteAccountToolOptions,
): AsyncGenerator<unknown, void, void> {
  const endpointUrl = options.tool.endpointUrl;
  if (!endpointUrl) {
    throw new Error(
      `Custom tool "${options.tool.name}" is missing its endpoint URL.`,
    );
  }

  const response = await guardedFetch(
    endpointUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...resolvedEndpointHeaders(options),
      },
      body: JSON.stringify(options.input ?? {}),
    },
    { timeoutMs: ENDPOINT_TIMEOUT_MS },
  );

  if (!response.ok) {
    throw new Error(
      `Custom tool "${options.tool.name}" endpoint responded with status ${response.status}: ${excerpt(response.bodyText)}`,
    );
  }

  yield parseEndpointOutput(response.bodyText);
}

/**
 * Stored headers with `${NAME}` values substituted from the merged per-tool
 * config's `env` map — `config.tools.<toolId>.config.env` on the agent side,
 * already carrying resolved secrets by the time core sees it.
 */
function resolvedEndpointHeaders(
  options: ExecuteAccountToolOptions,
): Record<string, string> {
  const config = mergeToolConfig(
    options.tool.defaultConfig,
    options.config.config,
  );
  const env = isPlainObject(config.env)
    ? (config.env as Record<string, unknown>)
    : {};

  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.tool.endpointHeaders ?? {})) {
    resolved[name] = value.replace(ENV_REF_PATTERN, (match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(env, key)) {
        throw new Error(
          `Custom tool "${options.tool.name}" header "${name}" references \${${key}}, which is not set under config.tools.${options.tool.toolId}.config.env`,
        );
      }

      return String(env[key]);
    });
  }

  return resolved;
}

// JSON when the endpoint spoke JSON, otherwise the raw text the model can read.
function parseEndpointOutput(bodyText: string): unknown {
  const trimmed = bodyText.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function excerpt(bodyText: string): string {
  const singleLine = bodyText.replace(/\s+/g, " ").trim();

  return singleLine.length > ERROR_BODY_EXCERPT_CHARS
    ? `${singleLine.slice(0, ERROR_BODY_EXCERPT_CHARS)}…`
    : singleLine;
}
