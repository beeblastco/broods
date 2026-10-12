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
 * Per-org seat billing on the managed service: an owner holds one free org,
 * and an invite needs a seat the owner paid for. The case turns
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
  importUsers(context, [invitee("first"), invitee("second")]);
  // Made before the cap is on, so an org left by an earlier run cannot stop it.
  const orgId = String(
    result(
      must(
        asAdmin("org/orgs:create", { name: `seats-${context.runId}` }),
        "create the free org",
      ),
    ),
  );

  must(
    context.convex(["env", "set", "BROODS_MANAGED_SERVICE", "true"]),
    "turn the managed service on",
  );
  try {
    await context.measure("free-org cap", async () => {
      const second = asAdmin("org/orgs:create", {
        name: `seats-${context.runId}-second`,
      });
      assertStep(
        "a second free org is refused",
        !second.ok && second.output.includes("You already own a free"),
        second.output.slice(-300),
      );
    });

    await context.measure("invite needs a seat", async () => {
      const free = asAdmin("org/members:add", {
        orgId: orgId,
        email: invitee("first"),
      });
      assertStep(
        "a free org has no seat to invite into",
        !free.ok && free.output.includes("which has one seat"),
        free.output.slice(-300),
      );

      fileSubscription(context, orgId, 2);
      const org = must(asAdmin("org/orgs:getActive", {}), "read the org");
      assertStep(
        "a paid subscription makes the org Pro",
        org.includes('"plan": "pro"'),
        org,
      );
      must(
        asAdmin("org/members:add", { orgId: orgId, email: invitee("first") }),
        "the invite lands on the paid seat",
      );
      const full = asAdmin("org/members:add", {
        orgId: orgId,
        email: invitee("second"),
      });
      assertStep(
        "an invite past the paid seats is refused",
        !full.ok && full.output.includes("Every seat"),
        full.output.slice(-300),
      );
    });
  } finally {
    context.convex(["env", "remove", "BROODS_MANAGED_SERVICE"]);
    // Self-hosted again, so removing the org cancels nothing in Stripe.
    asAdmin("org/orgs:remove", { orgId: orgId });
  }
}

/** File a paid subscription for the org, as the webhook does after reading it from Stripe. */
function fileSubscription(
  context: VerifyContext,
  orgId: string,
  seats: number,
): void {
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
  must(
    context.convex([
      "run",
      "stripe:applySubscriptionInternal",
      JSON.stringify({
        ticket: ticket,
        subscription: {
          stripeSubscriptionId: stripeSubscriptionId,
          stripeCustomerId: `cus_local_${context.runId}`,
          status: "active",
          currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 86_400,
          cancelAtPeriodEnd: false,
          quantity: seats,
          priceId: "price_local_seat",
          metadata: { userId: SELF_HOST_ADMIN.subject, orgId: orgId },
        },
      }),
    ]),
    "file the paid subscription",
  );
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
