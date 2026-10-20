import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { Doc } from "../../../packages/convex/_generated/dataModel.ts";
import {
  SELF_HOST_ADMIN,
  SELF_HOST_ISSUER,
} from "../../../packages/convex/model/selfHostAuth.ts";
import { assertStep, convexResult, type VerifyContext } from "../harness.ts";

interface ProjectAmounts {
  projectId: string;
  name: string;
  totals: { sandboxHours: number; egressGb: number; ingressGb: number };
}

/**
 * The Usage tab's split by project, through the deployed backend: usage
 * written the way core and the sandbox mirror write it lands on the project
 * it names, usage with no project stays the org's alone, and the dashboard's
 * query reads each of the admin's projects back. Core's own writes need S3 or
 * Lambda, which the stack has none of, so the case sends them as core does
 * (`account/budget:record` with a source); core's side is in its unit tests.
 */
export async function projectUsage(context: VerifyContext): Promise<void> {
  const identity = JSON.stringify({
    subject: SELF_HOST_ADMIN.subject,
    issuer: SELF_HOST_ISSUER,
    tokenIdentifier: `${SELF_HOST_ISSUER}|${SELF_HOST_ADMIN.subject}`,
    email: SELF_HOST_ADMIN.email,
  });
  const asAdmin = (fn: string, args: Record<string, unknown>): unknown => {
    const cli = context.convex([
      "run",
      "--identity",
      identity,
      fn,
      JSON.stringify(args),
    ]);
    assertStep(`${fn} answers the admin`, cli.ok, cli.output.slice(-300));
    const start = cli.output.search(/^[[{"\dn]/m);

    return start < 0 ? null : JSON.parse(cli.output.slice(start));
  };

  asAdmin("user:ensureSynced", {});
  // Node warns about these conflicting color flags on stderr. The CLI must
  // leave stdout parseable for callers such as the dashboard browser fixtures.
  const cli = spawnSync(
    "bun",
    [
      join(import.meta.dir, "..", "..", "local-stack.ts"),
      "convex",
      "run",
      "--identity",
      identity,
      "org/orgs:getActive",
      "{}",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: "1" },
    },
  );
  const previous: Doc<"orgs"> | null = JSON.parse(cli.stdout);
  assertStep(
    "the local Convex CLI keeps JSON on stdout and diagnostics on stderr",
    cli.status === 0 && cli.stderr.includes("NO_COLOR"),
    cli.stderr.slice(-300),
  );
  // An org of the case's own, made active for its steps, so the totals it
  // reads move only by what it writes.
  const orgId = String(
    asAdmin("org/orgs:create", { name: `usage-${context.runId}` }),
  );
  try {
    asAdmin("org/orgs:setActive", { orgId: orgId });
    // It prints an audit log line after its result, so the account is read back.
    context.convex([
      "run",
      "--identity",
      identity,
      "org/lifecycle:provision",
      JSON.stringify({ orgId: orgId }),
    ]);
    const active = asAdmin("org/orgs:getActiveAccount", {}) as {
      accountId: string;
    } | null;
    assertStep("the case's org has an account", active !== null, "none");
    const accountId = active.accountId;
    const support = String(
      asAdmin("project:create", { name: `usage-support-${context.runId}` }),
    );
    const sales = String(
      asAdmin("project:create", { name: `usage-sales-${context.runId}` }),
    );

    await context.measure("usage lands on its project", async () => {
      const record = (
        usage: Record<string, number>,
        source?: Record<string, string>,
      ): void => {
        convexResult(
          context,
          "account/budget:record",
          {
            accountId: accountId,
            usage: usage,
            ...(source ? { source: source } : {}),
          },
          "core's usage write is accepted",
        );
      };
      record({ egressGb: 0.25 }, { projectId: support });
      record({ ingressGb: 0.5 }, { projectId: sales });
      record({ egressGb: 0.125 });
      // A sandbox in the support project, launched and released the way the
      // sandbox mirror sees it.
      const reservationKey = `usage-${context.runId}`;
      convexResult(
        context,
        "sandbox/instances:upsert",
        {
          accountId: accountId,
          projectId: support,
          provider: "lambda",
          reservationKey: reservationKey,
          externalId: `vm-${context.runId}`,
          name: "default",
          specs: { vcpu: 1, memoryMb: 2048, storageGb: 8 },
        },
        "a project's sandbox is mirrored",
      );
      convexResult(
        context,
        "sandbox/instances:remove",
        { accountId: accountId, reservationKey: reservationKey },
        "the sandbox is released",
      );

      const split = asAdmin("account/budget:getForActiveOrg", {
        withProjects: true,
      }) as {
        projects: ProjectAmounts[];
      };
      const byId = new Map(split.projects.map((p) => [p.projectId, p]));
      const supportTotals = byId.get(support)?.totals;
      const salesTotals = byId.get(sales)?.totals;
      assertStep(
        "the dashboard reads each project's own usage",
        supportTotals?.egressGb === 0.25 &&
          (supportTotals?.sandboxHours ?? 0) > 0 &&
          supportTotals?.ingressGb === 0 &&
          salesTotals?.ingressGb === 0.5 &&
          salesTotals?.egressGb === 0 &&
          salesTotals?.sandboxHours === 0,
        JSON.stringify({ support: supportTotals, sales: salesTotals }),
      );
      const after = orgTotals();
      assertStep(
        "usage with no project counts for the org alone",
        after.egressGb === 0.375 &&
          after.ingressGb === 0.5 &&
          after.sandboxHours === supportTotals?.sandboxHours,
        JSON.stringify(after),
      );
    });
  } finally {
    if (previous) asAdmin("org/orgs:setActive", { orgId: previous._id });
    asAdmin("org/orgs:remove", { orgId: orgId });
  }

  function orgTotals(): ProjectAmounts["totals"] {
    const usage = asAdmin("account/budget:getForActiveOrg", {}) as {
      totals: ProjectAmounts["totals"];
    };

    return usage.totals;
  }
}
