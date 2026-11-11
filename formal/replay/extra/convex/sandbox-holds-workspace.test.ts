import { describe, expect, test } from "bun:test";
import { sandboxHoldsWorkspace } from "../../../../packages/convex/model/sandboxProviders.ts";

interface HoldsCase {
  name: string;
  storage: string | undefined;
  provider: string;
  persistent?: boolean;
  options?: Record<string, unknown>;
  holds: boolean;
}

const CASES: HoldsCase[] = [
  {
    name: "disk on a persistent worker",
    storage: "disk",
    provider: "worker",
    persistent: true,
    holds: true,
  },
  {
    name: "disk on a stateless worker",
    storage: "disk",
    provider: "worker",
    persistent: false,
    holds: false,
  },
  {
    name: "disk on another provider",
    storage: "disk",
    provider: "lambda",
    persistent: true,
    holds: false,
  },
  {
    name: "s3 on an opt-in provider without the option",
    storage: "s3",
    provider: "daytona",
    holds: false,
  },
  {
    name: "s3 on an opt-in provider with the option",
    storage: "s3",
    provider: "daytona",
    options: { mountAwsS3Buckets: true },
    holds: true,
  },
];

describe("sandboxHoldsWorkspace", (): void => {
  test.each(CASES)("$name", (entry: HoldsCase): void => {
    expect(
      sandboxHoldsWorkspace(entry.storage, {
        provider: entry.provider,
        persistent: entry.persistent,
        options: entry.options,
      }),
    ).toBe(entry.holds);
  });
});
