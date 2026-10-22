"use client";

import {
  AllowanceView,
  type UsageScope,
} from "@/app/(main)/[projectId]/dashboard/components/AllowanceUsage";
import type { BudgetUsage, UsageAmounts } from "@/app/lib/allowance";
import type { Id } from "@broods/convex/_generated/dataModel";

const MONTH = "2026-10";
const DAYS_SO_FAR = 16;

// Four projects of one Pro org, each busy on its own resources, plus usage no
// project made (an account-wide workspace, chat attachments).
const PROJECTS: Array<{
  id: string;
  name: string;
  perDay: UsageAmounts;
}> = [
  {
    id: "support-bot",
    name: "Support bot",
    perDay: {
      sandboxHours: 1.9,
      hostedMcpHours: 0.08,
      storageGb: 3.1,
      egressGb: 0.21,
      ingressGb: 0.34,
    },
  },
  {
    id: "sales-agent",
    name: "Sales agent",
    perDay: {
      sandboxHours: 0.7,
      hostedMcpHours: 0.21,
      storageGb: 1.2,
      egressGb: 0.05,
      ingressGb: 0.02,
    },
  },
  {
    id: "research",
    name: "Research",
    perDay: {
      sandboxHours: 3.2,
      hostedMcpHours: 0.02,
      storageGb: 9.8,
      egressGb: 0.01,
      ingressGb: 0,
    },
  },
  {
    id: "internal-tools",
    name: "Internal tools",
    perDay: {
      sandboxHours: 0.1,
      hostedMcpHours: 0,
      storageGb: 0.4,
      egressGb: 0,
      ingressGb: 0,
    },
  },
];

const OTHER_PER_DAY: UsageAmounts = {
  sandboxHours: 0.2,
  hostedMcpHours: 0,
  storageGb: 2.6,
  egressGb: 0.02,
  ingressGb: 0.05,
};

const CAPS = {
  sandboxHours: 200,
  hostedMcpHours: 20,
  storageGb: 50,
  egressGb: 10,
};

/**
 * Resources on fixed data: one org's month across four projects, as the
 * "Support bot" Usage tab or the organization's Usage page shows it.
 */
export function AllowanceStandIn({
  view,
}: {
  view: UsageScope;
}): React.JSX.Element {
  return (
    <div className="w-full max-w-6xl">
      <AllowanceView
        budget={BUDGET}
        view={view}
        month={undefined}
        onMonthChange={() => {}}
      />
    </div>
  );
}

// A day's amount for the day-th day: a weekly rhythm so the bars move.
function dayAmounts(perDay: UsageAmounts, day: number): UsageAmounts {
  const wave = 0.55 + ((day * 37) % 9) / 10;

  return {
    sandboxHours: perDay.sandboxHours * wave,
    hostedMcpHours: perDay.hostedMcpHours * wave,
    storageGb: perDay.storageGb,
    egressGb: perDay.egressGb * wave,
    ingressGb: perDay.ingressGb * wave,
  };
}

function days(perDay: UsageAmounts): Array<UsageAmounts & { day: string }> {
  return Array.from({ length: DAYS_SO_FAR }, (_, index) => ({
    day: `${MONTH}-${String(index + 1).padStart(2, "0")}`,
    ...dayAmounts(perDay, index + 1),
  }));
}

function sum(rows: UsageAmounts[]): UsageAmounts {
  const total = (key: keyof UsageAmounts): number =>
    rows.reduce((acc, row) => acc + (row[key] ?? 0), 0);

  return {
    sandboxHours: total("sandboxHours"),
    hostedMcpHours: total("hostedMcpHours"),
    storageGb: total("storageGb"),
    egressGb: total("egressGb"),
    ingressGb: total("ingressGb"),
  };
}

// Storage is a size: the month's amount is the last day's, not a sum.
function monthTotals(
  rows: Array<UsageAmounts & { day: string }>,
): UsageAmounts {
  return { ...sum(rows), storageGb: rows.at(-1)?.storageGb ?? null };
}

const SPLIT: NonNullable<BudgetUsage["projects"]> = PROJECTS.map((project) => {
  const own = days(project.perDay);

  return {
    projectId: project.id as Id<"projects">,
    name: project.name,
    totals: monthTotals(own),
    days: own,
  };
});

const ORG_DAYS = days(OTHER_PER_DAY).map((other, index) => ({
  ...sum([other, ...SPLIT.map((project) => project.days[index])]),
  day: other.day,
}));

const ORG_TOTALS = monthTotals(ORG_DAYS);
const ORG_SHARES = {
  sandboxHours: percent(ORG_TOTALS.sandboxHours, CAPS.sandboxHours),
  hostedMcpHours: percent(ORG_TOTALS.hostedMcpHours, CAPS.hostedMcpHours),
  storageGb: percent(ORG_TOTALS.storageGb ?? 0, CAPS.storageGb),
  egressGb: percent(ORG_TOTALS.egressGb, CAPS.egressGb),
};
// The owner's other org on the same pool, busy on egress: the pool sits
// above this org on every cap and has used egress up.
const POOL_TOTALS: UsageAmounts = {
  sandboxHours: ORG_TOTALS.sandboxHours + 37.1,
  hostedMcpHours: ORG_TOTALS.hostedMcpHours + 0.8,
  storageGb: (ORG_TOTALS.storageGb ?? 0) + 6,
  egressGb: CAPS.egressGb,
  ingressGb: ORG_TOTALS.ingressGb,
};
const POOL_SHARES = {
  sandboxHours: percent(POOL_TOTALS.sandboxHours, CAPS.sandboxHours),
  hostedMcpHours: percent(POOL_TOTALS.hostedMcpHours, CAPS.hostedMcpHours),
  storageGb: percent(POOL_TOTALS.storageGb ?? 0, CAPS.storageGb),
  egressGb: percent(POOL_TOTALS.egressGb, CAPS.egressGb),
};

const BUDGET: BudgetUsage = {
  enforced: true,
  plan: "pro",
  month: MONTH,
  months: [MONTH, "2026-09", "2026-08"],
  usedPercent: 100,
  caps: CAPS,
  shares: POOL_SHARES,
  orgShares: ORG_SHARES,
  level: "exhausted",
  totals: ORG_TOTALS,
  days: ORG_DAYS,
  projects: SPLIT,
  pool: { orgs: 2, shared: true, totals: POOL_TOTALS },
};

function percent(part: number, base: number): number {
  return Math.round((part / base) * 1000) / 10;
}
