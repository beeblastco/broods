import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import fc from "fast-check";
import { stripTrailingSlashes } from "../../apps/core/src/shared/paths.ts";
import { METHODS, ROUTERS, resolveRouter } from "../../apps/edge/src/routes.ts";
import { oracleRuns, oracleSeed } from "./oracle-options.ts";

const ORACLE = new URL("../.lake/build/bin/gateway-oracle", import.meta.url)
  .pathname;

// `Dest` in verification/Broods/Gateway.lean; `sockets` maps by rule order to `Socket`.
const DESTS: Record<string, string> = {
  health: "health",
  downloads: "config",
  config: "config",
  "secret-webhooks": "core",
  webhooks: "core",
  media: "core",
  core: "core",
};

const SOCKETS = ["terminal", "machine", "observability", "agent"];

const WORDS = [
  ...new Set(
    ROUTERS.flatMap((router) =>
      router.rules.flatMap(
        (rule) => rule.path.match(/[a-z0-9][a-z0-9-]*/g) ?? [],
      ),
    ),
  ),
];

const methodArb = fc.oneof(
  fc.constantFrom(...METHODS),
  fc.constantFrom(...METHODS).map((method) => method.toLowerCase()),
  fc.stringMatching(/^[A-Za-z]{1,8}$/),
);

const patternArb = fc.oneof(
  ...ROUTERS.flatMap((router) =>
    router.rules.map((rule) => fc.stringMatching(new RegExp(`^${rule.path}$`))),
  ),
);

const soupArb = fc
  .array(
    fc.oneof(fc.constantFrom("", "v2", ...WORDS), fc.stringMatching(/^[^/]+$/)),
    { maxLength: 9 },
  )
  .map((segments) => `/${segments.join("/")}`);

const requestArb = fc
  .record({
    method: methodArb,
    path: fc.oneof(
      patternArb,
      soupArb,
      soupArb.map((path) => `/v1${path}`),
    ),
    innerEmpty: fc.oneof(
      { arbitrary: fc.constant(null), weight: 3 },
      { arbitrary: fc.nat(), weight: 1 },
    ),
    trailing: fc.nat({ max: 3 }),
  })
  .map(({ method, path, innerEmpty, trailing }) => ({
    method: method,
    path: `${innerEmpty === null ? path : doubleSlash(path, innerEmpty)}${"/".repeat(trailing)}`,
  }));

test("resolveRouter agrees with the Lean model's route on generated requests", () => {
  if (!existsSync(ORACLE)) {
    throw new Error(
      `missing ${ORACLE}: run \`lake build gateway-oracle\` in verification/`,
    );
  }
  const requests = fc.sample(requestArb, {
    seed: oracleSeed(),
    numRuns: oracleRuns(),
  });
  const oracle = Bun.spawnSync([ORACLE], {
    stdin: Buffer.from(
      requests.map(({ method, path }) => `${method}\t${path}\n`).join(""),
    ),
  });
  expect(oracle.exitCode).toBe(0);
  const answers = oracle.stdout.toString().split("\n").slice(0, -1);
  expect(answers).toHaveLength(requests.length);

  const disagreements = requests
    .map((request, index) => ({
      ...request,
      ts: tsDest(request.method, request.path),
      lean: answers[index],
    }))
    .filter(({ ts, lean }) => ts !== lean)
    .toSorted(
      (a, b) =>
        a.method.length + a.path.length - b.method.length - b.path.length,
    );
  expect(disagreements.slice(0, 5)).toEqual([]);
});

function doubleSlash(path: string, pick: number): string {
  const slashes = [...path.matchAll(/\//g)].map((match) => match.index);
  const at = slashes[pick % slashes.length] ?? 0;

  return `${path.slice(0, at)}/${path.slice(at)}`;
}

function tsDest(method: string, path: string): string {
  const router = resolveRouter(method, path);
  if (!router) return "notFound";
  if (router.name !== "sockets")
    return DESTS[router.name] ?? `unmapped ${router.name}`;
  const stripped = stripTrailingSlashes(path) || "/";
  const index = router.rules.findIndex((rule) =>
    new RegExp(`^${rule.path}$`).test(stripped),
  );

  return `socket:${SOCKETS[index]}`;
}
