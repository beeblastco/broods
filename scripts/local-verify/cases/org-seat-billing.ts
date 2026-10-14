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
 * Per-org seat billing on the managed service: a Hobby owner holds one org
 * and cannot create another, Pro seats the owner and 2 developers, and an
 * invite past those needs a seat the owner paid for. The case turns
 * BROODS_MANAGED_SERVICE on for its own steps only and acts as the stack's
 * admin through the Convex CLI. The stack has no Stripe, so it files a paid
 * subscription the way the webhook does once it has read one back
 * (`stripe:applySubscriptionInternal`); Stripe's side is in the Convex tests.
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

  const managedBefore = must(
    context.convex(["env", "list"]),
    "read the stack's env",
  ).match(/^BROODS_MANAGED_SERVICE=(.*)$/m)?.[1];
  must(
    context.convex(["env", "set", "BROODS_MANAGED_SERVICE", "true"]),
    "turn the managed service on",
  );
  try {
    await context.measure("creating an org needs Pro", async () => {
      const second = asAdmin("org/orgs:create", {
        name: `seats-${context.runId}-second`,
      });
      assertStep(
        "a Hobby owner cannot create another org",
        !second.ok &&
          second.output.includes("Creating an organization needs Pro"),
        second.output.slice(-300),
      );
    });

    await context.measure("invite needs a seat", async () => {
      const free = asAdmin("org/members:add", {
        orgId: orgId,
        email: invitee("first"),
      });
      assertStep(
        "a Hobby org has no seat to invite into",
        !free.ok && free.output.includes("which has one seat"),
        free.output.slice(-300),
      );

      must(
        fileSubscription(context, orgId, "active"),
        "file the paid subscription",
      );
      const org = must(asAdmin("org/orgs:getActive", {}), "read the org");
      assertStep(
        "a paid subscription makes the org Pro",
        org.includes('"plan": "pro"'),
        org,
      );
      // What the dashboard's Billing tab, invite dialog and Account settings read.
      const billing = must(
        asAdmin("stripe:getBillingInfo", {}),
        "read the org's billing",
      );
      const info = result(billing);
      assertStep(
        "billing shows every member Pro's 3 seats, and no Stripe ids",
        typeof info === "object" &&
          info !== null &&
          Object.keys(info).sort().join() ===
            "cancelAtPeriodEnd,currentPeriodEnd,seats,status" &&
          "seats" in info &&
          info.seats === 3,
        billing,
      );
      const owned = must(
        asAdmin("stripe:listOwnedOrgs", {}),
        "list the owner's orgs",
      );
      const rows = result(owned);
      const row: unknown = Array.isArray(rows)
        ? rows.find(
            (org: unknown) =>
              typeof org === "object" &&
              org !== null &&
              "orgId" in org &&
              org.orgId === orgId,
          )
        : undefined;
      assertStep(
        "Account settings lists the org as Pro with its seats",
        typeof row === "object" &&
          row !== null &&
          "plan" in row &&
          row.plan === "pro" &&
          "seats" in row &&
          row.seats === 3,
        owned,
      );
      for (const name of ["first", "second"]) {
        must(
          asAdmin("org/members:add", { orgId: orgId, email: invitee(name) }),
          `the ${name} invite lands on a seat included with Pro`,
        );
      }
      const full = asAdmin("org/members:add", {
        orgId: orgId,
        email: invitee("third"),
      });
      assertStep(
        "an invite past the included seats is refused",
        !full.ok && full.output.includes("Every seat"),
        full.output.slice(-300),
      );
    });
  } finally {
    // Every step runs even when one before it failed. The subscription ends
    // first, so the admin is no longer billed as Pro, and the org goes once
    // the stack is self-hosted again, so its removal calls no Stripe.
    const cleanup: Array<[string, () => CliResult]> = [
      [
        "cancel the subscription",
        () => fileSubscription(context, orgId, "canceled"),
      ],
      [
        "restore BROODS_MANAGED_SERVICE",
        () =>
          context.convex(
            managedBefore === undefined
              ? ["env", "remove", "BROODS_MANAGED_SERVICE"]
              : ["env", "set", "BROODS_MANAGED_SERVICE", managedBefore],
          ),
      ],
      ["remove the org", () => asAdmin("org/orgs:remove", { orgId: orgId })],
    ];
    const failed = cleanup.flatMap(([step, cli]) => {
      const done = cli();

      return done.ok ? [] : [`${step}: ${done.output.slice(-300)}`];
    });
    assertStep("clean up", failed.length === 0, failed.join("\n"));
  }
}

/** File the org's one-unit Pro subscription, as the webhook does after reading it from Stripe. */
function fileSubscription(
  context: VerifyContext,
  orgId: string,
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
        metadata: { userId: SELF_HOST_ADMIN.subject, orgId: orgId },
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
