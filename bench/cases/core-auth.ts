import {
  extractBearerToken,
  timingSafeStringEqual,
} from "../../apps/core/src/shared/auth.ts";
import type { BenchCase } from "../runner.ts";

const ADMIN_SECRET = "admin-secret-9d2f41ba7c3e5089bd6a4e17c05b8f36";

const AUTHORIZATION_MIX: ReadonlyArray<string | undefined> = [
  "Bearer bsk_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p",
  "Bearer bsts_9z8y7x6w5v4u3t2s1r0q",
  "bearer bdts_aa11bb22cc33dd44ee55",
  "  Bearer   bsk_padded_token_value_here  ",
  "Basic ZGV2OmRldnBhc3N3b3Jk",
  "Bearer",
  undefined,
];

const NEAR_MISS_TOKEN = "admin-secret-9d2f41ba7c3e5089bd6a4e17c05b8f37";

export const coreAuthCases: readonly BenchCase[] = [
  {
    name: "core/bearer-token-extract",
    iterations: 100_000,
    run: (): unknown => {
      return extractBearerToken(
        AUTHORIZATION_MIX[headerCursor++ % AUTHORIZATION_MIX.length],
      );
    },
  },
  {
    name: "core/timing-safe-token-compare",
    iterations: 20_000,
    run: (): unknown => timingSafeStringEqual(NEAR_MISS_TOKEN, ADMIN_SECRET),
  },
];

let headerCursor = 0;
