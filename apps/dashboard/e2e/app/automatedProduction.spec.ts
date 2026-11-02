import { expect, test } from "@playwright/test";
import type { Doc, Id } from "../../../../packages/convex/_generated/dataModel";
import { activeOrg, idOf, run, STACK_ADMIN } from "../lib/localStack";
import { probeAccount } from "../lib/session";

test.skip(
  !probeAccount.adminKey,
  "Deploys through a self-hosted stack's Convex CLI; set E2E_ADMIN_KEY",
);

const PROJECT = `auto-prod-${Date.now().toString(36)}`;
let projectId: string;
let freshProjectId: string;

test.beforeAll(() => {
  const account = run(null, "account/accounts:getByOrgId", {
    orgId: activeOrg()._id,
  }) as Doc<"accounts"> | null;
  if (!account) throw new Error("The admin's org has no API account");
  const scope = run(null, "cli/sync:ensureScopeBySecretHash", {
    secretHash: account.secretHash,
    project: PROJECT,
    stage: "production",
  }) as { projectId: Id<"projects">; stageId: Id<"stages">; revision: number };
  run(null, "cli/sync:finishManifestSync", {
    stageId: scope.stageId,
    revision: scope.revision,
  });
  projectId = scope.projectId;
  freshProjectId = idOf(
    run(STACK_ADMIN, "project:create", { name: `${PROJECT}-fresh` }),
  );
});

test.afterAll(() => {
  const failures = [projectId, freshProjectId].flatMap((id) => {
    try {
      if (id) run(STACK_ADMIN, "project:remove", { projectId: id });

      return [];
    } catch (error) {
      return [error];
    }
  });
  if (failures.length > 0) throw new AggregateError(failures);
});

test("a Production stage deployed by automation opens without the setup dialog", async ({
  page,
}) => {
  await page.goto(`/${projectId}`);
  await page.getByRole("button", { name: "Development" }).click();
  await page.getByRole("menuitem", { name: "Production" }).click();

  await expect(
    page.getByRole("button", { name: "Production", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/stage=/);
  await expect(page.getByText("Initialize Production")).toHaveCount(0);
});

test("a project with no Production stage still offers to initialize it", async ({
  page,
}) => {
  await page.goto(`/${freshProjectId}`);
  await page.getByRole("button", { name: "Development" }).click();
  await page.getByRole("menuitem", { name: "Production" }).click();

  await expect(
    page.getByRole("heading", { name: "Initialize Production" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Europe \(Ireland\)/ }),
  ).toBeEnabled();
  await expect(page.getByRole("button", { name: /US East/ })).toBeDisabled();
});
