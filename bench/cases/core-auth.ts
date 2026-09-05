/**
 * Core's per-request bearer auth. `extractBearerToken` runs on every request
 * that carries a header; `timingSafeStringEqual` runs twice more on every
 * request whose token is not prefix-routed, which is every account-secret and
 * runtime-key call — two SHA-256 digests each, by design.
 */

import {
  extractBearerToken,
  timingSafeStringEqual,
} from "../../apps/core/src/shared/auth.ts";
import type { BenchCase } from "../runner.ts";

const ADMIN_SECRET = "fp_admin_9d2f41ba7c3e5089bd6a4e17c05b8f36";

// The header shapes the extractor actually sees, including the malformed ones
// it has to reject without allocating its way through them.
const AUTHORIZATION_MIX: ReadonlyArray<string | undefined> = [
  "Bearer fp_agent_1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p",
  "Bearer fp_sts_9z8y7x6w5v4u3t2s1r0q",
  "bearer fp_dts_aa11bb22cc33dd44ee55",
  "  Bearer   fp_agent_padded_token_value_here  ",
  "Basic ZGV2OmRldnBhc3N3b3Jk",
  "Bearer",
  undefined,
];

// A token of the same length as a real runtime key, differing in the last byte,
// so the comparison walks the full digest rather than short-circuiting.
const NEAR_MISS_TOKEN = "fp_admin_9d2f41ba7c3e5089bd6a4e17c05b8f37";

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
