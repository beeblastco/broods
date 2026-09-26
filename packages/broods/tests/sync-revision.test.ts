/**
 * `putManifest` sends the revision a dev sync read, and turns the server's
 * `manifest_conflict` into a `ManifestConflictError` that `broods dev` retries.
 */

import { expect, test } from "bun:test";
import type { CliManifest } from "../src/contracts.ts";
import { BroodsSyncClient, ManifestConflictError } from "../src/sync.ts";

const MANIFEST: CliManifest = {
  version: 1 as const,
  project: "demo-app",
  stage: "development",
  resources: [],
};

test("a revision rides the PUT body, and none is sent without one", async () => {
  const bodies: string[] = [];
  const client = stubClient((init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");

    return Response.json({ manifest: {}, ids: {}, revision: 6 });
  });

  const result = await client.putManifest(MANIFEST, false, false, 5);
  await client.putManifest(MANIFEST, false);

  expect(result.revision).toBe(6);
  expect(JSON.parse(bodies[0]!)).toMatchObject({ revision: 5 });
  expect(JSON.parse(bodies[1]!)).not.toHaveProperty("revision");
});

test("a manifest conflict is its own error, another 409 is not", async () => {
  const conflict = stubClient(() =>
    Response.json(
      { error: { message: "Stage changed", code: "manifest_conflict" } },
      { status: 409 },
    ),
  );
  const nameClash = stubClient(() =>
    Response.json(
      { error: { message: "already exists", code: "conflict" } },
      { status: 409 },
    ),
  );

  await expect(conflict.putManifest(MANIFEST, false, false, 5)).rejects.toThrow(
    ManifestConflictError,
  );
  const error = await nameClash
    .putManifest(MANIFEST, false)
    .catch((caught: unknown) => caught);
  expect(error).not.toBeInstanceOf(ManifestConflictError);
  expect(String(error)).toContain("409 already exists");
});

function stubClient(
  respond: (init: RequestInit | undefined) => Response,
): BroodsSyncClient {
  return new BroodsSyncClient({
    baseUrl: "https://convex.example.com",
    token: "tok",
    fetch: async (_input, init) => respond(init),
  });
}
