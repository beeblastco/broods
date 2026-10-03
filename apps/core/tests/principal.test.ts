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
  type Principal,
} from "../src/shared/domain/principal.ts";
import { openRunToken, sealRunToken } from "../src/shared/run-token.ts";

const RUN = {
  accountId: "acct_1",
  agentId: "agent_1",
  eventId: "evt_1",
  conversationKey: "acct:acct_1:agent:agent_1:slack:C1",
};

describe("principal chain", () => {
  it("names the channel sender on a channel turn, nobody when the adapter gave none", () => {
    expect(
      channelPrincipalChain(
        { userId: "U1", userName: "Ada", channelId: "C1" },
        "slack",
      ),
    ).toEqual([{ kind: "user", id: "U1", name: "Ada", channel: "slack" }]);
    expect(channelPrincipalChain({ channelId: "C1" }, "slack")).toEqual([]);
    expect(channelPrincipalChain(undefined, "slack")).toEqual([]);
  });

  it("names the key kind on a direct run and the scheduler on a cron", () => {
    expect(directPrincipalChain({})).toEqual([
      { kind: "api", keyKind: "account" },
    ]);
    expect(directPrincipalChain({ endpointId: "env-endpoint" })).toEqual([
      { kind: "api", keyKind: "deployment" },
    ]);
    expect(
      directPrincipalChain({
        endpointId: "env-endpoint",
        cronRun: { cronId: "cron_1", runId: "run_1" },
      }),
    ).toEqual([{ kind: "api", keyKind: "cron" }]);
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
      { ...RUN, agentId: "agent_2", eventId: "evt_2" },
      delegatedChain(parent),
    )!;
    expect(child).toEqual({
      kind: "agent",
      accountId: "acct_1",
      agentId: "agent_2",
      runId: "evt_2",
      conversationKey: RUN.conversationKey,
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
  const principal: Principal = {
    kind: "agent",
    accountId: "acct_1",
    agentId: "agent_1",
    runId: "evt_1",
    chain: [{ kind: "api", keyKind: "account" }],
  };
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.STAGE_TICKET_SECRET;
    process.env.STAGE_TICKET_SECRET = "stage-secret";
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.STAGE_TICKET_SECRET;
    else process.env.STAGE_TICKET_SECRET = previousSecret;
  });

  it("opens what it sealed, with the principal intact", () => {
    const token = sealRunToken(principal, 1_000, 60_000);
    expect(token.startsWith("fp_run_")).toBe(true);
    expect(openRunToken(token, 60_999)).toEqual(principal);
  });

  it("carries chain ids and kinds, never a channel user's display name", () => {
    const token = sealRunToken(
      {
        ...principal,
        chain: [
          { kind: "user", id: "U1", name: "Ada Lovelace", channel: "slack" },
          { kind: "agent", agentId: "agent_0" },
        ],
      },
      1_000,
      60_000,
    );
    const payload = Buffer.from(
      token.slice("fp_run_".length).split(".")[0]!,
      "base64url",
    ).toString("utf8");
    expect(payload).not.toContain("Ada");
    expect(openRunToken(token, 2_000)?.chain).toEqual([
      { kind: "user", id: "U1", channel: "slack" },
      { kind: "agent", agentId: "agent_0" },
    ]);
  });

  it("refuses an expired, tampered, foreign or malformed token", () => {
    const token = sealRunToken(principal, 1_000, 60_000);
    expect(openRunToken(token, 61_000)).toBeNull();
    const [payload, signature] = token.slice("fp_run_".length).split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...principal, agentId: "agent_2", exp: 61_000 }),
    ).toString("base64url");
    expect(openRunToken(`fp_run_${forged}.${signature}`, 1)).toBeNull();
    expect(openRunToken(`fp_run_${payload}.${signature}x`, 1)).toBeNull();
    expect(openRunToken(`fp_run_${payload}`, 1)).toBeNull();
    expect(openRunToken(`fp_dts_${payload}.${signature}`, 1)).toBeNull();
    process.env.STAGE_TICKET_SECRET = "rotated";
    expect(openRunToken(token, 1)).toBeNull();
  });
});
