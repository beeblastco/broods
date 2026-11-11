import { describe, expect, test } from "bun:test";

import {
  createAccountId,
  createAccountSecret,
} from "../../../../apps/core/src/shared/domain/accounts.ts";

describe("account identifiers", () => {
  test("ids and secrets carry their prefixes", (): void => {
    expect(createAccountId()).toMatch(/^acct_[0-9a-f]{24}$/);
    expect(createAccountSecret()).toMatch(/^bask_[\w-]{43}$/);
  });
});
