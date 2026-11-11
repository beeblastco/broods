import { expect, test } from "vitest";
import * as roles from "../account/roles";
import * as deployments from "../agent/deployments";
import * as policies from "../agent/policies";
import * as dashboardReads from "../dashboardReads";
import * as orgs from "../org/orgs";
import * as project from "../project";
import * as runtimeLookups from "../runtimeLookups";
import * as stage from "../stage";

// Convex deploys before core and the dashboard roll, so the old paths answer for one release.
test("the old paths serve the moved functions", () => {
  expect(deployments.getByApiKeyHash).toBe(
    runtimeLookups.deploymentByApiKeyHash,
  );
  expect(policies.getById).toBe(runtimeLookups.policyById);
  expect(roles.resolveSession).toBe(runtimeLookups.roleSessionByTokenHash);
  expect(orgs.getActive).toBe(dashboardReads.activeOrg);
  expect(orgs.getActiveAccount).toBe(dashboardReads.activeAccount);
  expect(orgs.list).toBe(dashboardReads.orgs);
  expect(project.getById).toBe(dashboardReads.projectById);
  expect(project.list).toBe(dashboardReads.projects);
  expect(stage.list).toBe(dashboardReads.stages);
});
