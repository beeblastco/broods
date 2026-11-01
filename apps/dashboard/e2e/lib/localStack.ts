import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SELF_HOST_ADMIN,
  SELF_HOST_ISSUER,
} from "../../../../packages/convex/model/selfHostAuth";

const LOCAL_STACK = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "local-stack.ts",
);

export interface StackUser {
  authId: string;
  email: string;
  name: string;
  identity: string;
}

export const STACK_ADMIN = stackUser(
  SELF_HOST_ADMIN.subject,
  SELF_HOST_ADMIN.email,
  "Admin",
);

export function convex(args: string[]): string {
  const result = spawnSync("bun", [LOCAL_STACK, "convex", ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `convex ${args.slice(0, 2).join(" ")} failed: ${(result.stdout + result.stderr).slice(-400)}`,
    );
  }

  return result.stdout;
}

export function run(
  user: StackUser | null,
  fn: string,
  args: Record<string, unknown>,
): unknown {
  const output = convex([
    "run",
    ...(user ? ["--identity", user.identity] : []),
    fn,
    JSON.stringify(args),
  ]);
  // `convex run` prints any log lines before the JSON result.
  const start = output.search(/^[[{"\d]/m);

  return start < 0 ? null : JSON.parse(output.slice(start));
}

export interface OrgRow {
  _id: string;
  name: string;
}

export function activeOrg(): OrgRow {
  const org = run(STACK_ADMIN, "org/orgs:getActive", {});
  if (
    typeof org !== "object" ||
    org === null ||
    !("_id" in org) ||
    !("name" in org)
  ) {
    throw new Error("The stack's admin has no active org");
  }

  return { _id: idOf(org._id), name: idOf(org.name) };
}

export function idOf(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected a string, got ${JSON.stringify(value)}`);
  }

  return value;
}

export function addUser(
  authId: string,
  email: string,
  name: string,
): StackUser {
  const now = new Date().toISOString();
  importRows("users", [
    { authId: authId, email: email, name: name, plan: "free" },
  ]);
  importRows(
    "users",
    [
      {
        id: authId,
        email: email,
        name: name,
        emailVerified: true,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    ],
    "workOSAuthKit",
  );

  return stackUser(authId, email, name);
}

// Run with the managed service off, so a seat the user frees calls no Stripe.
export function removeUser(user: StackUser): void {
  run(null, "org/workosUserDeletion:finalize", { authId: user.authId });
  convex([
    "run",
    "--component",
    "workOSAuthKit",
    "lib:processEvent",
    JSON.stringify({
      event: {
        id: `evt_e2e_delete_${user.authId}`,
        createdAt: new Date().toISOString(),
        event: "user.deleted",
        data: { id: user.authId },
      },
    }),
  ]);
}

export function fileSubscription(
  payer: StackUser,
  subscriptionId: string,
  quantity: number,
  status: "active" | "past_due" | "canceled",
): void {
  const ticket = run(null, "stripe:claimSubscriptionSyncInternal", {
    stripeSubscriptionId: subscriptionId,
  });
  run(null, "stripe:applySubscriptionInternal", {
    ticket: ticket,
    subscription: {
      stripeSubscriptionId: subscriptionId,
      stripeCustomerId: `cus_${subscriptionId}`,
      status: status,
      currentPeriodEnd: Math.floor(Date.now() / 1000) + 30 * 86_400,
      cancelAtPeriodEnd: false,
      quantity: quantity,
      priceId: "price_local_seat",
      metadata: { userId: payer.authId },
    },
  });
}

function stackUser(authId: string, email: string, name: string): StackUser {
  return {
    authId: authId,
    email: email,
    name: name,
    identity: JSON.stringify({
      subject: authId,
      issuer: SELF_HOST_ISSUER,
      tokenIdentifier: `${SELF_HOST_ISSUER}|${authId}`,
      email: email,
    }),
  };
}

function importRows(
  table: string,
  rows: Array<Record<string, unknown>>,
  component?: string,
): void {
  const dir = mkdtempSync(join(tmpdir(), "broods-e2e-"));
  const path = join(dir, `${table}.jsonl`);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  try {
    convex([
      "import",
      "--append",
      "-y",
      ...(component ? ["--component", component] : []),
      "--table",
      table,
      path,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
