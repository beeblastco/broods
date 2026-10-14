import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SELF_HOST_ADMIN,
  SELF_HOST_ISSUER,
} from "../../../packages/convex/model/selfHostAuth.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

interface CliResult {
  ok: boolean;
  output: string;
}

/**
 * Seat billing on the managed service: a Hobby owner keeps one org, cannot
 * create another and has no developer seats. Pro belongs to the owner: it
 * puts every org they own on Pro, lets them create more, and gives them 2
 * developer seats shared across those orgs, so a developer already seated in
 * one joins another free and a new one past the pool needs a seat the owner
 * paid for. The case turns BROODS_MANAGED_SERVICE on for its own steps only
 * and acts as the stack's admin through the Convex CLI. The stack has no
 * Stripe, so it files a paid subscription the way the webhook does once it
 * has read one back (`stripe:applySubscriptionInternal`); Stripe's side is in
 * the Convex tests.
 */
export async function orgSeatBilling(context: VerifyContext): Promise<void> {
  const identity = JSON.stringify({
    subject: SELF_HOST_ADMIN.subject,
    issuer: SELF_HOST_ISSUER,
    tokenIdentifier: `${SELF_HOST_ISSUER}|${SELF_HOST_ADMIN.subject}`,
    email: SELF_HOST_ADMIN.email,
  });
  const asAdmin = (fn: string, args: Record<string, string>): CliResult =>
    context.convex(["run", "--identity", identity, fn, JSON.stringify(args)]);
  const invitee = (name: string): string =>
    `seat-${name}-${context.runId}@broods.local`;

  must(asAdmin("user:ensureSynced", {}), "the admin's user is synced");
  importUsers(context, [invitee("first"), invitee("second"), invitee("third")]);
  // Made before the rule is on, so an org left by an earlier run cannot stop it.
  const orgId = String(
    result(
      must(
        asAdmin("org/orgs:create", { name: `seats-${context.runId}` }),
        "create the free org",
      ),
    ),
  );
  let secondOrgId: string | undefined;

  const managedBefore = must(
    context.convex(["env", "list"]),
    "read the stack's env",
  ).match(/^BROODS_MANAGED_SERVICE=(.*)$/m)?.[1];
  must(
    context.convex(["env", "set", "BROODS_MANAGED_SERVICE", "true"]),
    "turn the managed service on",
  );
  try {
    await context.measure("Hobby keeps one org and no seats", async () => {
      const second = asAdmin("org/orgs:create", {
        name: `seats-${context.runId}-second`,
      });
      assertStep(
        "a Hobby owner cannot create another org",
        !second.ok &&
          second.output.includes("Creating another organization needs Pro"),
        second.output.slice(-300),
      );
      const free = asAdmin("org/members:add", {
        orgId: orgId,
        email: invitee("first"),
      });
      assertStep(
        "a Hobby owner has no developer seat to invite into",
        !free.ok && free.output.includes("which has no developer seats"),
        free.output.slice(-300),
      );
    });

    await context.measure("Pro shares its seats across orgs", async () => {
      must(fileSubscription(context, "active"), "file the paid subscription");
      const org = must(asAdmin("org/orgs:getActive", {}), "read the org");
      assertStep(
        "a paid subscription puts the owner's org on Pro",
        org.includes('"plan": "pro"'),
        org,
      );
      // What the dashboard's Billing tab and invite dialog read.
      const billing = must(
        asAdmin("stripe:getBillingInfo", {}),
        "read the owner's billing",
      );
      const info = result(billing);
      assertStep(
        "billing shows Pro's 2 developer seats, and no Stripe ids",
        typeof info === "object" &&
          info !== null &&
          Object.keys(info).sort().join() === "developers,seats,subscription" &&
          "seats" in info &&
          info.seats === 2,
        billing,
      );

      secondOrgId = String(
        result(
          must(
            asAdmin("org/orgs:create", {
              name: `seats-${context.runId}-second`,
            }),
            "a Pro owner creates another org",
          ),
        ),
      );
      const owned = must(
        asAdmin("stripe:listOwnedOrgs", {}),
        "list the owner's orgs",
      );
      const rows = result(owned);
      assertStep(
        "Account settings lists both orgs on Pro",
        Array.isArray(rows) &&
          [orgId, secondOrgId].every((id) =>
            rows.some(
              (row: unknown) =>
                typeof row === "object" &&
                row !== null &&
                "orgId" in row &&
                row.orgId === id &&
                "plan" in row &&
                row.plan === "pro",
            ),
          ),
        owned,
      );

      for (const name of ["first", "second"]) {
        must(
          asAdmin("org/members:add", { orgId: orgId, email: invitee(name) }),
          `the ${name} invite lands on a seat included with Pro`,
        );
      }
      must(
        asAdmin("org/members:add", {
          orgId: secondOrgId,
          email: invitee("first"),
        }),
        "a developer already seated joins the second org free",
      );
      const holders = must(
        asAdmin("stripe:listSeatHolders", {}),
        "list the seat holders",
      );
      const seated = result(holders);
      assertStep(
        "the developer in both orgs holds one seat, listed with both",
        Array.isArray(seated) &&
          seated.length === 2 &&
          seated.some(
            (row: unknown) =>
              typeof row === "object" &&
              row !== null &&
              "orgs" in row &&
              Array.isArray(row.orgs) &&
              row.orgs.length === 2,
          ),
        holders,
      );
      const full = asAdmin("org/members:add", {
        orgId: secondOrgId,
        email: invitee("third"),
      });
      assertStep(
        "a new developer past the pool is refused",
        !full.ok && full.output.includes("Every developer seat"),
        full.output.slice(-300),
      );
    });
  } finally {
    // Every step runs even when one before it failed. The subscription ends
    // first, so the admin is no longer billed as Pro, and the orgs go once
    // the stack is self-hosted again, so their removal calls no Stripe.
    const cleanup: Array<[string, () => CliResult]> = [
      ["cancel the subscription", () => fileSubscription(context, "canceled")],
      [
        "restore BROODS_MANAGED_SERVICE",
        () =>
          context.convex(
            managedBefore === undefined
              ? ["env", "remove", "BROODS_MANAGED_SERVICE"]
              : ["env", "set", "BROODS_MANAGED_SERVICE", managedBefore],
          ),
      ],
      ...[orgId, secondOrgId].flatMap((id): Array<[string, () => CliResult]> =>
        id
          ? [[`remove ${id}`, () => asAdmin("org/orgs:remove", { orgId: id })]]
          : [],
      ),
    ];
    const failed = cleanup.flatMap(([step, cli]) => {
      const done = cli();

      return done.ok ? [] : [`${step}: ${done.output.slice(-300)}`];
    });
    assertStep("clean up", failed.length === 0, failed.join("\n"));
  }
}

/** File the admin's one-unit Pro subscription, as the webhook does after reading it from Stripe. */
function fileSubscription(
  context: VerifyContext,
  status: "active" | "canceled",
): CliResult {
  const stripeSubscriptionId = `sub_local_${context.runId}`;
  const ticket = Number(
    result(
      must(
        context.convex([
          "run",
          "stripe:claimSubscriptionSyncInternal",
          JSON.stringify({ stripeSubscriptionId: stripeSubscriptionId }),
        ]),
        "claim a sync ticket",
      ),
    ),
  );
  return context.convex([
    "run",
    "stripe:applySubscriptionInternal",
    JSON.stringify({
      ticket: ticket,
      subscription: {
        stripeSubscriptionId: stripeSubscriptionId,
        stripeCustomerId: `cus_local_${context.runId}`,
        status: status,
        currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 86_400,
        cancelAtPeriodEnd: false,
        quantity: 1,
        priceId: "price_local_seat",
        metadata: { userId: SELF_HOST_ADMIN.subject },
      },
    }),
  ]);
}

/** Users who signed in once, so an org can invite them by email. */
function importUsers(context: VerifyContext, emails: string[]): void {
  const path = join(tmpdir(), `broods-seat-users-${context.runId}.jsonl`);
  writeFileSync(
    path,
    emails
      .map((email) =>
        JSON.stringify({
          authId: `local-${email}`,
          email: email,
          name: email,
          plan: "free",
        }),
      )
      .join("\n") + "\n",
  );
  try {
    must(
      context.convex(["import", "--append", "--table", "users", path]),
      "import the invitees",
    );
  } finally {
    rmSync(path, { force: true });
  }
}

function must(cli: CliResult, step: string): string {
  assertStep(step, cli.ok, cli.output.slice(-300));

  return cli.output;
}

/** The function's result: `convex run` prints it as JSON after any log lines. */
function result(output: string): unknown {
  return JSON.parse(output.slice(output.search(/^[[{"\d]/m)));
}
