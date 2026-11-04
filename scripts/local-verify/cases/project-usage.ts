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

// The stack has no S3 or Lambda, so usage is written as core writes it; core has unit tests.
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
  const previous = asAdmin("org/orgs:getActive", {}) as Doc<"orgs"> | null;
  // An org of its own, so the totals move only by what this case writes.
  const orgId = String(
    asAdmin("org/orgs:create", { name: `usage-${context.runId}` }),
  );
  try {
    asAdmin("org/orgs:setActive", { orgId: orgId });
    // Node warns about conflicting color flags on stderr; stdout must stay JSON.
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
    assertStep(
      "the local Convex CLI keeps JSON on stdout and diagnostics on stderr",
      cli.status === 0 &&
        cli.stdout.length > 0 &&
        cli.stderr.includes("NO_COLOR"),
      JSON.stringify({
        error: cli.error?.message,
        signal: cli.signal,
        status: cli.status,
        stderr: cli.stderr.slice(-1000),
        stdout: cli.stdout.slice(-300),
      }),
    );
    const cliOrg: Doc<"orgs"> = JSON.parse(cli.stdout);
    assertStep(
      "the local Convex CLI returns the selected org",
      cliOrg._id === orgId,
      cli.stdout,
    );
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
