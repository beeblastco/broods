/**
 * Per-org seat billing on the managed service, as the org owner and as an
 * admin of someone else's org: the Billing tab, the invite dialog with every
 * seat taken, the free-org cap on New organization, and Account settings.
 * Only a self-hosted stack can stage it: the spec turns the managed service
 * on, adds a second user who owns an org the stack's admin is invited into,
 * and files subscriptions the way the Stripe webhook does. The stack has no
 * Stripe, so no button that would reach it is pressed.
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

test("an owner on the free plan sees their one seat and what Upgrade costs", async ({
  page,
}) => {
  await openBilling(page, readProjectId());

  await expect(
    page.getByRole("heading", { name: `Plan · ${adminOrg.name}` }),
  ).toBeVisible();
  await expect(page.getByText(/· 1 seat \(yours\)$/)).toBeVisible();
  await expect(page.getByText("1 of 1 used")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Upgrade to Pro · 1 seat · €20/month" }),
  ).toBeEnabled();
});

test("a free owner's invite with no free seat offers the upgrade instead", async ({
  page,
}) => {
  await openMembers(page);
  await expect(page.getByText("1 of 1 seats used")).toBeVisible();

  const dialog = await openInvite(page);
  await expect(
    dialog.getByText(
      `${adminOrg.name} is on the free plan, which has one seat: yours.`,
    ),
  ).toBeVisible();
  await expect(dialog.getByLabel("Role")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Upgrade · €20/month" }),
  ).toBeEnabled();
});

test("a second free org is refused at create, and Upgrade opens the free one's Billing", async ({
  page,
}) => {
  await openBilling(page, readProjectId());
  await page.getByRole("button", { name: adminOrg.name }).click();
  await page.getByRole("menuitem", { name: "Create organization" }).click();
  const dialog = page.getByRole("dialog", { name: "New organization" });
  await dialog.getByLabel("Name").fill("Side Project");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await expect(
    dialog.getByText(/^You already own a free organization \(.+\)\.$/),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: /^Upgrade / }).click();
  await page.waitForURL(/\/dashboard\?tab=billing/);
  await expect(page.getByRole("heading", { name: /^Plan · / })).toBeVisible();
  // Upgrade made the free org active; the steps below are the admin's org.
  run(STACK_ADMIN, "org/orgs:setActive", { orgId: adminOrg._id });
});

test("a Pro owner adds a seat behind a confirm, and a full invite pays for one first", async ({
  page,
}) => {
  fileSubscription(adminOrg._id, STACK_ADMIN, subId("admin"), 1, "active");
  await openBilling(page, readProjectId());
  await expect(
    page.getByText(/^1 seat · €20\/month · Renews on /),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage subscription", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add seat", exact: true }).click();
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
  await expect(dialog.getByText("€20 / month")).toBeVisible();
  // The invite goes first, so an email nobody signed in with charges nothing.
  await dialog.getByLabel("Email").fill(`nobody-${RUN_ID}@broods.local`);
  await dialog.getByRole("button", { name: "Pay for seat and invite" }).click();
  await expect(dialog.getByText(/No user with that email/)).toBeVisible();
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
  await expect(row.getByText("Pro · 1 seat")).toBeVisible();
  await expect(
    row.getByRole("button", { name: "Billing", exact: true }),
  ).toBeVisible();
  await expect(billing.getByText(OWNER.org, { exact: true })).toHaveCount(0);
});

test("an admin of someone else's org sees its plan and seats, never a pay button", async ({
  page,
}) => {
  run(STACK_ADMIN, "org/orgs:setActive", { orgId: acmeId });
  try {
    await openBilling(page, acmeProjectId);
    await expect(
      page.getByText(new RegExp(`· owner ${OWNER.name}$`)),
    ).toBeVisible();
    // The sidebar names the active org's plan, not the admin's own Pro org's.
    await expect(page.getByText("Hobby plan", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Upgrade to Pro", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText(/ of \d+ used$/)).toHaveCount(0);

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

    fileSubscription(acmeId, owner, subId("acme"), 3, "active");
    await openBilling(page, acmeProjectId);
    await expect(
      page.getByText(
        new RegExp(`^3 seats · paid by ${OWNER.name} \\(owner\\) · Renews on `),
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add seat", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Manage subscription", exact: true }),
    ).toHaveCount(0);
  } finally {
    run(STACK_ADMIN, "org/orgs:setActive", { orgId: adminOrg._id });
  }
});

async function openBilling(page: Page, projectId: string): Promise<void> {
  await page.goto(`/${projectId}/dashboard?tab=billing`);
  await page.locator(SIDEBAR_READY).waitFor();
  await expect(page.getByRole("heading", { name: /^Plan · / })).toBeVisible();
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
