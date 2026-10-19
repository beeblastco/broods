/**
 * Billing on the managed service, as an owner and as an admin of someone
 * else's org: Pro belongs to the owner and covers every org they own, with
 * one pool of developer seats across them. The Billing tab's plan, seats and
 * monthly bill, the invite dialog with every seat taken, New organization
 * needing Pro, and Account settings. Only a self-hosted stack can stage it:
 * the spec turns the managed service on, adds a second user who owns an org
 * the stack's admin is invited into, and two developers who join the admin's
 * org once they are on Pro, one of them also in a second org the admin
 * creates, and files subscriptions the way the Stripe webhook does. The
 * stack has no Stripe, so no button that would reach it is pressed.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  activeOrg,
  addUser,
  convex,
  fileSubscription,
  idOf,
  type OrgRow,
  removeUser,
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
// The second org the admin creates once on Pro.
const LAB = "Tracy Lab";

let adminOrg: OrgRow;
let owner: StackUser;
// The developers who join the admin's Pro org.
const developers: StackUser[] = [];
let acmeId: string;
let acmeProjectId: string;
let labId: string | undefined;
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
    () => fileSubscription(STACK_ADMIN, subId("admin"), 1, "canceled"),
    () => owner && fileSubscription(owner, subId("acme"), 1, "canceled"),
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
    () => acmeId && run(owner, "org/orgs:remove", { orgId: acmeId }),
    () => labId && run(STACK_ADMIN, "org/orgs:remove", { orgId: labId }),
    // Self-hosted again, so the seats the users free call no Stripe.
    ...[owner, ...developers].map((user) => () => user && removeUser(user)),
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
  // The plan name alone: Hobby wears no badge, like a paid plan in good standing.
  const plan = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Your plan" }),
  });
  await expect(plan.getByText("Hobby", { exact: true })).toBeVisible();
  await expect(plan.getByText("Free", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText(/^Resets .+ · just you · you can join other people's orgs$/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upgrade to Pro · €20/month" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("heading", { name: "Developer seats" }),
  ).toBeVisible();
  await expect(page.getByText("No developer seats on Hobby")).toBeVisible();
  await expect(
    page.getByText(
      "Pro is €20/month: it lets you create orgs and gives you 2 developer seats to use across all of them. Extra seats are €20/month each.",
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
  await expect(page.getByText("0 of 0 developer seats used")).toBeVisible();

  const dialog = await openInvite(page);
  await expect(
    dialog.getByText("You are on Hobby, which has no developer seats."),
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
  await dialog.getByLabel("Name").fill("Side Project");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(
    dialog.getByText(
      "Creating another organization needs Pro. Upgrade to Pro first.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    dialog.getByText("You can still join an org when its owner invites you."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Upgrade to Pro" }).click();
  await page.waitForURL(/\/dashboard\?tab=billing/);
  await expect(page.getByRole("heading", { name: "Your plan" })).toBeVisible();
  // Upgrade made the Hobby org active; the steps below are the admin's org.
  run(STACK_ADMIN, "org/orgs:setActive", { orgId: adminOrg._id });
});

test("a Pro owner shares 2 developer seats across their orgs, and adds one once they are taken", async ({
  page,
}) => {
  fileSubscription(STACK_ADMIN, subId("admin"), 1, "active");
  for (const developer of developers) {
    run(STACK_ADMIN, "org/members:add", {
      orgId: adminOrg._id,
      email: developer.email,
      role: "member",
    });
  }
  // Pro creates more orgs; a developer already seated joins one free, and
  // anyone new finds the pool full.
  labId = idOf(run(STACK_ADMIN, "org/orgs:create", { name: LAB }));
  run(STACK_ADMIN, "org/orgs:setActive", { orgId: adminOrg._id });
  run(STACK_ADMIN, "org/members:add", {
    orgId: labId,
    email: developers[0].email,
    role: "member",
  });
  expect(() =>
    run(STACK_ADMIN, "org/members:add", {
      orgId: labId,
      email: owner.email,
      role: "member",
    }),
  ).toThrow(/Every developer seat is taken/);

  await openBilling(page, readProjectId());
  await expect(page.getByText(/^€20\/month · renews /)).toBeVisible();
  // Two orgs on one pool of caps: the note counts them for the owner.
  await expect(
    page.getByText("Limits are shared across 2 organizations."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage subscription", exact: true }),
  ).toBeVisible();

  await expect(
    page.getByText("2 of 2 developer seats used across your orgs"),
  ).toBeVisible();
  await expect(
    page.getByText("2 included with Pro", { exact: true }),
  ).toBeVisible();
  const seats = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Developer seats" }),
  });
  // One row, and one seat, per developer, with every org they are in.
  await expect(
    seatRow(page, developers[0].name).getByText(`${adminOrg.name}, ${LAB}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    seatRow(page, developers[1].name).getByText(adminOrg.name, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(seats.getByRole("listitem")).toHaveCount(2);
  await expectBill(page, 0, "€20/month");

  await page.getByRole("button", { name: "Add seat · €20/month" }).click();
  const confirm = page.getByRole("dialog", { name: "Add a developer seat" });
  await expect(
    confirm.getByText(
      "Add 1 seat for €20/month, to use in any of your orgs. You are charged now for the rest of this period.",
    ),
  ).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();

  await openMembers(page);
  await expect(page.getByText("2 of 2 developer seats used")).toBeVisible();
  const dialog = await openInvite(page);
  await expect(
    dialog.getByText("Every developer seat is taken."),
  ).toBeVisible();
  await expect(dialog.getByText("€20/month")).toBeVisible();
  // The invite goes first, so an email nobody signed in with charges nothing.
  await dialog.getByLabel("Email").fill(`nobody-${RUN_ID}@broods.local`);
  await dialog.getByRole("button", { name: "Pay for seat and invite" }).click();
  // The refusal reads as a sentence, with no server request line around it.
  await expect(
    dialog.getByText(
      "No user with that email. They must sign in once before being added.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("an extra seat shows on the seat count and the monthly bill", async ({
  page,
}) => {
  fileSubscription(STACK_ADMIN, subId("admin"), 2, "active");
  try {
    await openBilling(page, readProjectId());
    await expect(
      page.getByText("2 of 3 developer seats used across your orgs"),
    ).toBeVisible();
    await expect(
      page.getByText("2 included with Pro and 1 extra", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add seat/ })).toHaveCount(
      0,
    );
    await expectBill(page, 1, "€40/month");
  } finally {
    fileSubscription(STACK_ADMIN, subId("admin"), 1, "active");
  }
});

test("an owner whose payment failed sees Pro on hold, and is sent to Manage billing, not to Upgrade", async ({
  page,
}) => {
  fileSubscription(STACK_ADMIN, subId("admin"), 1, "past_due");
  try {
    await openBilling(page, readProjectId());
    const plan = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Your plan" }),
    });
    await expect(plan.getByText("Pro", { exact: true })).toBeVisible();
    await expect(plan.getByText("Payment due", { exact: true })).toBeVisible();
    await expect(
      plan.getByText("€20/month · on hold until Stripe has the payment"),
    ).toBeVisible();
    await expect(plan.getByText("Hobby", { exact: true })).toHaveCount(0);
    const seats = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Developer seats" }),
    });
    await expect(seats.getByText("Seats on hold")).toBeVisible();
    await expect(seats.getByRole("listitem")).toHaveCount(2);
    await expect(seats.getByText(/kept from before seats counted/)).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("heading", { name: "What you pay each month" }),
    ).toHaveCount(0);

    await openMembers(page);
    await expect(
      page.getByText("Seats on hold until Stripe has the payment"),
    ).toBeVisible();
    await expect(page.getByText(/developer seats used/)).toHaveCount(0);
    const dialog = await openInvite(page);
    await expect(
      dialog.getByText("Your last payment did not go through."),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Manage billing", exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByRole("button", { name: /^Upgrade/ })).toHaveCount(
      0,
    );
  } finally {
    fileSubscription(STACK_ADMIN, subId("admin"), 1, "active");
  }
});

test("Account settings lists every org you own on your plan", async ({
  page,
}) => {
  await page.goto("/settings/account");
  await page.locator(SIDEBAR_READY).waitFor();

  const billing = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Billing", exact: true }),
  });
  await expect(
    billing.getByText(/^Your plan covers every organization you own\./),
  ).toBeVisible();
  for (const name of [adminOrg.name, LAB]) {
    const row = billing.getByText(name, { exact: true }).locator("..");
    await expect(row.getByText("Pro", { exact: true })).toBeVisible();
    await expect(
      row.getByRole("button", { name: "Billing", exact: true }),
    ).toBeVisible();
  }
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
    await expect(page.getByText(/ of \d+ developer seats used/)).toHaveCount(0);

    await openMembers(page);
    // The owner's seats are theirs to see: no count, and only the invite's
    // refusal sends the admin to the owner.
    await expect(page.getByText(/developer seats used/)).toHaveCount(0);
    const dialog = await openInvite(page);
    await expect(dialog.getByTestId("invite-seat-notice")).toHaveCount(0);
    await dialog.getByLabel("Email").fill(developers[0].email);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      dialog.getByText(
        `Ask ${OWNER.name}, the owner, to add a developer seat in Billing. Someone already on one of their seats joins free. You are never charged.`,
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    fileSubscription(owner, subId("acme"), 1, "active");
    await openBilling(page, acmeProjectId);
    await expect(
      page.getByText(
        `This org runs on ${OWNER.name}'s Pro plan. You are not charged.`,
      ),
    ).toBeVisible();
    // Who pays is the plain line above; a paid plan in good standing wears no badge.
    await expect(page.getByText("Active", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/^Paid by /)).toHaveCount(0);
    await expect(
      page.getByText(`Developer seat in ${OWNER.org}`),
    ).toBeVisible();
    // The admin pays for their own org, apart from this one.
    await expect(
      page.getByText(
        `A developer seat from ${OWNER.name}'s Pro plan. Your own Pro plan is billed separately.`,
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
  await expect(
    bill.getByText(`Extra seats · ${extra} × €20/month`),
  ).toBeVisible();
  await expect(
    bill.getByText("Total", { exact: true }).locator("..").getByText(total),
  ).toBeVisible();
}

/** A developer's row in the owner's seat list. */
function seatRow(page: Page, name: string): ReturnType<Page["locator"]> {
  return page
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function openMembers(page: Page): Promise<void> {
  await page.goto("/settings/org?tab=members");
  await page.locator(SIDEBAR_READY).waitFor();
}

async function openInvite(page: Page): Promise<ReturnType<Page["getByRole"]>> {
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Invite member" });
  await expect(dialog).toBeVisible();

  return dialog;
}

function subId(org: string): string {
  return `sub_e2e_${org}_${RUN_ID}`;
}
