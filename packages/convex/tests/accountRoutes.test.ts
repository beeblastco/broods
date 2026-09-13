import { describe, expect, it } from "vitest";
import { parseAccountRoute } from "../config/routes/accounts";

describe("parseAccountRoute", () => {
  it("parses the self routes", () => {
    expect(parseAccountRoute("/v1/account")).toEqual({ kind: "self" });
    expect(parseAccountRoute("/v1/account/rotate-secret")).toEqual({
      kind: "selfRotate",
    });
  });

  it("parses the admin collection and its members", () => {
    expect(parseAccountRoute("/v1/accounts")).toEqual({ kind: "adminList" });
    expect(parseAccountRoute("/v1/accounts/acct_1")).toEqual({
      kind: "adminRecord",
      accountId: "acct_1",
    });
    expect(parseAccountRoute("/v1/accounts/acct_1/rotate-secret")).toEqual({
      kind: "adminRotate",
      accountId: "acct_1",
    });
  });

  it("decodes an encoded account id", () => {
    expect(parseAccountRoute("/v1/accounts/acct%2F1")).toEqual({
      kind: "adminRecord",
      accountId: "acct/1",
    });
  });

  it("does not answer the retired unversioned paths", () => {
    expect(parseAccountRoute("/accounts")).toBeNull();
    expect(parseAccountRoute("/accounts/acct_1")).toBeNull();
    expect(parseAccountRoute("/accounts/acct_1/rotate-secret")).toBeNull();
  });

  it("reports an unknown shape under the admin prefix", () => {
    expect(parseAccountRoute("/v1/accounts/acct_1/nope")).toEqual({
      kind: "adminUnknown",
    });
  });
});
