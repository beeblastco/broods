/**
 * The per-run principal: how the delegation chain is built for each way a
 * run starts, and the run token that carries it into a sandbox.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  channelPrincipalChain,
  delegatedChain,
  directPrincipalChain,
  principalChainLabel,
  runPrincipal,
} from "../src/shared/domain/principal.ts";
import { openRunToken, sealRunToken } from "../src/shared/run-token.ts";

const RUN = { accountId: "acct_1", agentId: "agent_1" };

describe("principal chain", () => {
  it("names the channel sender on a channel turn, and no chain when the adapter gave none", () => {
    expect(
      channelPrincipalChain(
        { userId: "U1", userName: "Ada", channelId: "C1" },
        "slack",
      ),
    ).toEqual([{ kind: "user", id: "U1", name: "Ada", channel: "slack" }]);
    expect(channelPrincipalChain({ channelId: "C1" }, "slack")).toBeUndefined();
    expect(channelPrincipalChain(undefined, "slack")).toBeUndefined();
  });

  it("names the scheduler on a cron and guesses nothing for a rebuilt envelope", () => {
    expect(
      directPrincipalChain({ cronRun: { cronId: "cron_1", runId: "run_1" } }),
    ).toEqual([{ kind: "api", keyKind: "cron" }]);
    // No chain from the router, no cron, no stored sender: the requester is
    // unknown, and the ledger row carries no chain rather than a guess.
    expect(directPrincipalChain({})).toBeUndefined();
    expect(
      directPrincipalChain({ replyTarget: { channelName: "slack" } }),
    ).toBeUndefined();
    const unknown = runPrincipal(RUN, directPrincipalChain({}))!;
    expect("chain" in unknown).toBe(false);
    expect(delegatedChain(unknown)).toBeUndefined();
    expect(principalChainLabel(unknown)).toBeUndefined();
  });

  it("keeps the router's chain and reads a channel continuation's sender", () => {
    const chain = [
      { kind: "user", id: "U1", channel: "slack" },
      { kind: "agent", agentId: "agent_0" },
    ] as const;
    expect(directPrincipalChain({ principalChain: [...chain] })).toEqual([
      ...chain,
    ]);
    expect(
      directPrincipalChain({
        replyTarget: { channelName: "telegram", identity: { userId: "42" } },
      }),
    ).toEqual([{ kind: "user", id: "42", channel: "telegram" }]);
  });

  it("delegates to a subagent by appending the parent agent", () => {
    const parent = runPrincipal(RUN, [
      { kind: "user", id: "U1", channel: "slack" },
    ])!;
    const child = runPrincipal(
      { ...RUN, agentId: "agent_2" },
      delegatedChain(parent),
    )!;
    expect(child).toEqual({
      kind: "agent",
      accountId: "acct_1",
      agentId: "agent_2",
      chain: [
        { kind: "user", id: "U1", channel: "slack" },
        { kind: "agent", agentId: "agent_1" },
      ],
    });
    expect(principalChainLabel(child)).toBe(
      "user:U1>agent:agent_1>agent:agent_2",
    );
    expect(runPrincipal({ ...RUN, agentId: undefined }, [])).toBeUndefined();
  });
});

describe("run token", () => {
  const subject = { accountId: "acct_1", agentId: "agent_1" };
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.STAGE_TICKET_SECRET;
    process.env.STAGE_TICKET_SECRET = "stage-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.STAGE_TICKET_SECRET;
    else process.env.STAGE_TICKET_SECRET = previousSecret;
  });

  it("opens what it sealed, and signs the account, the agent and an expiry only", () => {
    // A whole principal goes in; its chain, with a user id and a display
    // name, stays out of a payload the sandbox can read.
    const token = sealRunToken(
      runPrincipal(RUN, [
        { kind: "user", id: "U1", name: "Ada Lovelace", channel: "slack" },
      ])!,
      1_000,
      60_000,
    );
    expect(token.startsWith("brt_")).toBe(true);
    expect(openRunToken(token, 60_999)).toEqual(subject);
    expect(
      JSON.parse(
        Buffer.from(
          token.slice("brt_".length).split(".")[0]!,
          "base64url",
        ).toString("utf8"),
      ),
    ).toEqual({ ...subject, exp: 61_000 });
  });

  it("refuses an expired, tampered, foreign or malformed token", () => {
    const token = sealRunToken(subject, 1_000, 60_000);
    expect(openRunToken(token, 61_000)).toBeNull();
    const [payload, signature] = token.slice("brt_".length).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...subject, agentId: "agent_2", exp: 61_000 }),
    ).toString("base64url");
    expect(openRunToken(`brt_${forged}.${signature}`, 1)).toBeNull();
    expect(openRunToken(`brt_${payload}.${signature}x`, 1)).toBeNull();
    expect(openRunToken(`brt_${payload}`, 1)).toBeNull();
    expect(openRunToken(`fp_dts_${payload}.${signature}`, 1)).toBeNull();
    process.env.STAGE_TICKET_SECRET = "rotated";
    expect(openRunToken(token, 1)).toBeNull();
  });
});
