/**
 * Fails CI when a new `error.code` ships without a row in the API reference,
 * or a row stays for a code nothing answers with any more.
 */

import { describe, expect, it } from "bun:test";
import { CLIENT_ERROR_STATUS } from "@broods/convex/model/clientError";
import {
  BUDGET_EXHAUSTED,
  PLAN_LIMIT_EXCEEDED,
} from "@broods/convex/model/planLimits";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const OPENAPI_PATH = `${REPO_ROOT}apps/docs/docs/api-reference/openapi.yaml`;
// Everything that answers a public request: core, the gateway, the config plane.
const SOURCE_ROOTS = ["apps/core/src", "apps/gateway/src", "packages/convex"];
const SKIPPED_DIRS = ["_generated/", "node_modules/", "tests/"];
const CODE_LITERAL = /\bcode: "([a-z_]+)"/g;
// The MicroVM executor's harness request runs the shell command `true`.
const NOT_ERROR_CODES = new Set(["true"]);
// The Slack channel directory route relays each failure `reason` as the code.
const SLACK_DIRECTORY_PATH = "packages/convex/model/slackDirectory.ts";
const REASON_LITERAL = /\breason: "([a-z_]+)"/g;
const CATALOGUE_ROW = /^\| `([a-z_]+)` \|/gm;

interface OpenApiDocument {
  components: {
    schemas: {
      Error: {
        properties: {
          error: { properties: { code: { description: string } } };
        };
      };
    };
  };
}

describe("openapi error code catalogue", (): void => {
  it("documents every code the API can answer with", async (): Promise<void> => {
    const documented = await documentedCodes();
    const missing = [...(await emittedCodes())].filter(
      (code): boolean => !documented.has(code),
    );

    expect(missing.sort()).toEqual([]);
  });

  it("lists no code the API no longer answers with", async (): Promise<void> => {
    const emitted = await emittedCodes();
    const stale = [...(await documentedCodes())].filter(
      (code): boolean => !emitted.has(code),
    );

    expect(stale.sort()).toEqual([]);
  });
});

async function documentedCodes(): Promise<Set<string>> {
  const document = Bun.YAML.parse(
    await Bun.file(OPENAPI_PATH).text(),
  ) as OpenApiDocument;
  const description =
    document.components.schemas.Error.properties.error.properties.code
      .description;

  return new Set(matches(description, CATALOGUE_ROW));
}

async function emittedCodes(): Promise<Set<string>> {
  const codes = new Set<string>([
    ...Object.keys(CLIENT_ERROR_STATUS),
    BUDGET_EXHAUSTED,
    PLAN_LIMIT_EXCEEDED,
    ...matches(
      await Bun.file(`${REPO_ROOT}${SLACK_DIRECTORY_PATH}`).text(),
      REASON_LITERAL,
    ),
  ]);
  for (const root of SOURCE_ROOTS) {
    const cwd = `${REPO_ROOT}${root}/`;
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: cwd })) {
      if (SKIPPED_DIRS.some((dir): boolean => `/${path}`.includes(`/${dir}`)))
        continue;
      const source = await Bun.file(`${cwd}${path}`).text();
      for (const code of matches(source, CODE_LITERAL)) {
        if (!NOT_ERROR_CODES.has(code)) codes.add(code);
      }
    }
  }

  return codes;
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match): string => match[1]!);
}
