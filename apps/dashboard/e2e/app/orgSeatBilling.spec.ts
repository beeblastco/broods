/**
 * Per-org billing on the managed service, as the org owner and as an admin of
 * someone else's org: the Billing tab's plan, seats and monthly bill, the
 * invite dialog with every seat taken, New organization needing Pro, and
 * Account settings. Only a self-hosted stack can stage it: the spec turns the
 * managed service on, adds a second user who owns an org the stack's admin
 * is invited into, two developers who join the admin's org once it is on
 * Pro, and files subscriptions the way the Stripe webhook does. The stack has
 * no Stripe, so no button that would reach it is pressed.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  addUser,
  convex,
  fileSubscription,
  run,
  STACK_ADMIN,
  type StackUser,
} from "../lib/localStack";
import { probeAccount, readProjectId } from "../lib/session";

test.skip(
  !probeAccount.adminKey,
  "Stages billing through a self-hosted stack's Convex CLI; set E2E_ADMIN_KEY",
);
test.describe.configure({ mode: "serial" });

const SIDEBAR_READY = '[data-slot="sidebar-container"][data-hydrated="true"]';
const RUN_ID = Date.now().toString(36);
const OWNER = { name: "Ada Lovelace", org: "Acme Robotics" };

interface OrgRow {
  _id: string;
  name: string;
}

let adminOrg: OrgRow;
let owner: StackUser;
// The developers on the admin's Pro org, and their memberships.
const developers: StackUser[] = [];
const developerSeats: string[] = [];
let acmeId: string;
let acmeProjectId: string;
// BROODS_MANAGED_SERVICE before the spec set it: null when unset,
// undefined while the spec has not touched it.
let managedBefore: string | null | undefined;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  adminOrg = activeOrg();
  owner = addUser(
    `e2e-owner-${RUN_ID}`,
    `ada-${RUN_ID}@broods.local`,
    OWNER.name,
  );
  acmeId = idOf(run(owner, "org/orgs:create", { name: OWNER.org }));
  // The account a project needs; its one-time secret is dropped unread.
  convex([
    "run",
    "--identity",
    owner.identity,
    "org/lifecycle:provision",
    JSON.stringify({ orgId: acmeId }),
  ]);
  run(owner, "org/members:add", {
    orgId: acmeId,
    email: STACK_ADMIN.email,
    role: "admin",
  });
  run(STACK_ADMIN, "org/orgs:setActive", { orgId: acmeId });
  acmeProjectId = idOf(run(STACK_ADMIN, "project:create", { name: "robots" }));
  run(STACK_ADMIN, "org/orgs:setActive", { orgId: adminOrg._id });
  for (const name of ["Grace Hopper", "Alan Turing"]) {
    const slug = name.split(" ")[0].toLowerCase();
    developers.push(
      addUser(`e2e-${slug}-${RUN_ID}`, `${slug}-${RUN_ID}@broods.local`, name),
    );
  }
  managedBefore =
    convex(["env", "list"]).match(/^BROODS_MANAGED_SERVICE=(.*)$/m)?.[1] ??
    null;
  convex(["env", "set", "BROODS_MANAGED_SERVICE", "true"]);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  // Every step runs even when one before it failed, so a broken run never
  // leaves the stack managed for the specs after it. Subscriptions end first,
  // and the org goes once the stack is as it was, so its removal calls no Stripe.
  // Steps for state beforeAll never reached are skipped.
  const steps: Array<() => unknown> = [
    () =>
      adminOrg &&
      fileSubscription(
        adminOrg._id,
        STACK_ADMIN,
        subId("admin"),
        1,
        "canceled",
      ),
    () =>
      acmeId && fileSubscription(acmeId, owner, subId("acme"), 3, "canceled"),
    () =>
      managedBefore !== undefined &&
      convex(
        managedBefore === null
          ? ["env", "remove", "BROODS_MANAGED_SERVICE"]
          : ["env", "set", "BROODS_MANAGED_SERVICE", managedBefore],
      ),
    () =>
      adminOrg &&
      run(STACK_ADMIN, "org/orgs:setActive", { orgId: adminOrg._id }),
    // Self-hosted again, so giving back their seats calls no Stripe.
    ...developerSeats.map(
      (membershipId) => () =>
        run(STACK_ADMIN, "org/members:remove", { membershipId: membershipId }),
    ),
    () => acmeId && run(owner, "org/orgs:remove", { orgId: acmeId }),
  ];
  const failures = steps.flatMap((step) => {
    try {
      step();

      return [];
    } catch (error) {
      return [error];
    }
  });
  if (failures.length > 0) throw failures[0];
});

test("an owner on Hobby sees their plan, no developer seats, and what Upgrade costs", async ({
  page,
}) => {
  await openBilling(page, readProjectId());

  await expect(page.getByRole("heading", { name: "Your plan" })).toBeVisible();
  await expect(
    page.getByText(/^Resets .+ · just you · you can join other people's orgs$/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upgrade to Pro · €20/month" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: `Seats · ${adminOrg.name}` }),
  ).toBeVisible();
  await expect(page.getByText("No developer seats on Hobby")).toBeVisible();
  await expect(
    page.getByText(
      "Pro lets you create an org and includes 2 developer seats. Extra seats are €20/month each.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What you pay each month" }),
  ).toHaveCount(0);
});

test("a Hobby owner's invite with no free seat offers the upgrade instead", async ({
  page,
}) => {
  await openMembers(page);
  await expect(page.getByText("1 of 1 seats used")).toBeVisible();

  const dialog = await openInvite(page);
  await expect(
    dialog.getByText(
      `${adminOrg.name} is on Hobby, which has one seat: yours.`,
    ),
  ).toBeVisible();
  await expect(dialog.getByLabel("Role")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Upgrade · €20/month" }),
  ).toBeEnabled();
});

test("creating an org needs Pro, and Upgrade opens the Hobby org's Billing", async ({
  page,
}) => {
  await openBilling(page, readProjectId());
  await page.getByRole("button", { name: adminOrg.name }).click();
  await page.getByRole("menuitem", { name: "Create organization" }).click();
  const dialog = page.getByRole("dialog", { name: "New organization" });

  await expect(
    dialog.getByText("Creating an organization needs Pro"),
  ).toBeVisible();
  await expect(
    dialog.getByText("You can still join an org when its owner invites you."),
  ).toBeVisible();
  await expect(dialog.getByLabel("Name")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Upgrade to Pro" }).click();
  await page.waitForURL(/\/dashboard\?tab=billing/);
  await expect(page.getByRole("heading", { name: "Your plan" })).toBeVisible();
  // Upgrade made the Hobby org active; the steps below are the admin's org.
  run(STACK_ADMIN, "org/orgs:setActive", { orgId: adminOrg._id });
});

test("a Pro owner sees the seats Pro includes, what each costs, and adds one once they are taken", async ({
  page,
}) => {
  fileSubscription(adminOrg._id, STACK_ADMIN, subId("admin"), 1, "active");
  for (const developer of developers) {
    developerSeats.push(
      idOf(
        run(STACK_ADMIN, "org/members:add", {
          orgId: adminOrg._id,
          email: developer.email,
          role: "member",
        }),
      ),
    );
  }
  await openBilling(page, readProjectId());
  await expect(page.getByText(/^€20\/month · renews /)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage subscription", exact: true }),
  ).toBeVisible();

  await expect(page.getByText("3 of 3 seats used")).toBeVisible();
  await expect(
    page.getByText("You, plus 2 developer seats included with Pro", {
      exact: true,
    }),
  ).toBeVisible();
  const seats = page.locator("section").filter({
    has: page.getByRole("heading", { name: `Seats · ${adminOrg.name}` }),
  });
  await expect(seats.getByText("Owner", { exact: true })).toBeVisible();
  await expect(
    seats.getByText("Included with Pro", { exact: true }),
  ).toHaveCount(2);
  await expectBill(page, 0, "€20/month");

  await page.getByRole("button", { name: "Add seat · €20/month" }).click();
  const confirm = page.getByRole("dialog", {
    name: `Add a seat to ${adminOrg.name}`,
  });
  await expect(
    confirm.getByText(
      "Add 1 seat for €20/month. You are charged now for the rest of this period.",
    ),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();

  await openMembers(page);
  const dialog = await openInvite(page);
  await expect(
    dialog.getByText(`Every seat in ${adminOrg.name} is taken.`),
  ).toBeVisible();
  await expect(dialog.getByText("€20/month")).toBeVisible();
  // The invite goes first, so an email nobody signed in with charges nothing.
  await dialog.getByLabel("Email").fill(`nobody-${RUN_ID}@broods.local`);
  await dialog.getByRole("button", { name: "Pay for seat and invite" }).click();
  await expect(dialog.getByText(/No user with that email/)).toBeVisible();
});

test("an extra seat shows on the seat count and the monthly bill", async ({
  page,
}) => {
  fileSubscription(adminOrg._id, STACK_ADMIN, subId("admin"), 2, "active");
  try {
    await openBilling(page, readProjectId());
    await expect(page.getByText("3 of 4 seats used")).toBeVisible();
    await expect(
      page.getByText(
        "You, plus 2 developer seats included with Pro and 1 extra",
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add seat/ })).toHaveCount(
      0,
    );
    await expectBill(page, 1, "€40/month");
  } finally {
    fileSubscription(adminOrg._id, STACK_ADMIN, subId("admin"), 1, "active");
  }
});

test("an owner whose payment failed is sent to Manage billing, not to Upgrade", async ({
  page,
}) => {
  fileSubscription(adminOrg._id, STACK_ADMIN, subId("admin"), 1, "past_due");
  try {
    await openMembers(page);
    const dialog = await openInvite(page);
    await expect(
      dialog.getByText(`${adminOrg.name}'s last payment did not go through.`),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Manage billing", exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByRole("button", { name: /^Upgrade/ })).toHaveCount(
      0,
    );
  } finally {
    fileSubscription(adminOrg._id, STACK_ADMIN, subId("admin"), 1, "active");
  }
});

test("Account settings lists each org you own with its plan", async ({
  page,
}) => {
  await page.goto("/settings/account");
  await page.locator(SIDEBAR_READY).waitFor();

  const billing = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Billing", exact: true }),
  });
  const row = billing.getByText(adminOrg.name, { exact: true }).locator("..");
  await expect(row.getByText("Pro · 3 seats")).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Billing", exact: true }),
  ).toBeVisible();
  await expect(billing.getByText(OWNER.org, { exact: true })).toHaveCount(0);
});

test("an admin of someone else's org sees its plan and their own seat, never a pay button", async ({
  page,
}) => {
  run(STACK_ADMIN, "org/orgs:setActive", { orgId: acmeId });
  try {
    await openBilling(page, acmeProjectId);
    await expect(
      page.getByRole("heading", { name: `Plan · ${OWNER.org}` }),
    ).toBeVisible();
    await expect(
      page.getByText(
        `This org runs on ${OWNER.name}'s Hobby plan. You are not charged.`,
      ),
    ).toBeVisible();
    // The sidebar names the active org's plan, not the admin's own Pro org's.
    await expect(page.getByText("Hobby plan", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Upgrade to Pro", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("heading", { name: "Your seat" }),
    ).toBeVisible();
    await expect(page.getByText(/ of \d+ seats used$/)).toHaveCount(0);

    await openMembers(page);
    const dialog = await openInvite(page);
    await expect(
      dialog.getByText(
        `Ask ${OWNER.name}, the owner, to add a seat in Billing. You are never charged.`,
      ),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Add", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    fileSubscription(acmeId, owner, subId("acme"), 1, "active");
    await openBilling(page, acmeProjectId);
    await expect(
      page.getByText(
        `This org runs on ${OWNER.name}'s Pro plan. You are not charged.`,
      ),
    ).toBeVisible();
    await expect(page.getByText(`Paid by ${OWNER.name}`)).toBeVisible();
    await expect(
      page.getByText(`Developer seat in ${OWNER.org}`),
    ).toBeVisible();
    // The admin pays for their own org, apart from this one.
    await expect(
      page.getByText(
        `One of the 2 seats included with ${OWNER.name}'s Pro plan. Your own Pro plan is billed separately.`,
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add seat/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("button", { name: "Manage subscription", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "What you pay each month" }),
    ).toHaveCount(0);
  } finally {
    run(STACK_ADMIN, "org/orgs:setActive", { orgId: adminOrg._id });
  }
});

async function openBilling(page: Page, projectId: string): Promise<void> {
  await page.goto(`/${projectId}/dashboard?tab=billing`);
  await page.locator(SIDEBAR_READY).waitFor();
  await expect(
    page.getByRole("heading", { name: /^(Your plan|Plan · .+)$/ }),
  ).toBeVisible();
}

/** The owner's monthly bill: Pro, `extra` seats past the included ones, and the total. */
async function expectBill(
  page: Page,
  extra: number,
  total: string,
): Promise<void> {
  const bill = page.locator("section").filter({
    has: page.getByRole("heading", { name: "What you pay each month" }),
  });
  await expect(
    bill.getByText("Pro plan (includes 2 developer seats)"),
  ).toBeVisible();
  await expect(bill.getByText(`Extra seats · ${extra} × €20`)).toBeVisible();
  await expect(bill.getByText(total, { exact: true })).toBeVisible();
}

async function openMembers(page: Page): Promise<void> {
  await page.goto("/settings/org?tab=members");
  await page.locator(SIDEBAR_READY).waitFor();
}

async function openInvite(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Invite member" });
  await expect(dialog.getByTestId("invite-seat-notice")).toBeVisible();

  return dialog;
}

function activeOrg(): OrgRow {
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

/** A function's string result, such as a new document's id. */
function idOf(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected a string, got ${JSON.stringify(value)}`);
  }

  return value;
}

function subId(org: string): string {
  return `sub_e2e_${org}_${RUN_ID}`;
}
