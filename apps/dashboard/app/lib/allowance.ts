import type { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { BudgetLevel } from "@broods/convex/model/planLimits";
import type { FunctionReturnType } from "convex/server";
import { SERIES_COLORS } from "./usageChart";

const DISPLAY_UNITS: Record<
  AmountUnit,
  Array<{ label: string; perUnit: number }>
> = {
  hours: [
    { label: " h", perUnit: 1 },
    { label: " min", perUnit: 60 },
    { label: " s", perUnit: 3600 },
  ],
  gb: [
    { label: " GB", perUnit: 1 },
    { label: " MB", perUnit: 1000 },
    { label: " KB", perUnit: 1_000_000 },
  ],
};

export type BudgetUsage = NonNullable<
  FunctionReturnType<typeof api.account.budget.getForActiveOrg>
>;

export type UsageAmounts = BudgetUsage["totals"];

type UsageDay = BudgetUsage["days"][number];

export interface UsageSlice {
  projectId: string | null;
  name: string;
  color: string;
  totals: UsageAmounts;
  days: UsageDay[];
}

export type AmountUnit = "hours" | "gb";

const FLOAT_NOISE = 1e-9;

export const OTHER_USAGE_COLOR = "var(--color-muted-foreground)";

export const OTHER_ORGS_COLOR = "var(--color-usage-other-orgs)";

export const BUDGET_LEVEL_TEXT: Record<BudgetLevel, string> = {
  ok: "text-muted-foreground",
  warning: "text-warning",
  exhausted: "text-destructive",
};

export const ALLOWANCE_ROWS: AllowanceRow[] = [
  {
    key: "sandboxHours",
    label: "Sandbox time",
    unit: "hours",
    share: "sandboxHours",
    color: "var(--color-usage-agent-sandbox)",
    help: "Hours your sandboxes spent running, idle time until they stop included, at the default 1 vCPU / 2 GB size. A bigger sandbox, a resume or a kept snapshot uses hours faster. A V8 Worker counts only the seconds its commands ran, loading their stored files included. Sandboxes on your own provider account are free.",
  },
  {
    key: "hostedMcpHours",
    label: "Hosted MCP time",
    unit: "hours",
    share: "hostedMcpHours",
    color: "var(--color-usage-mcp-sandbox)",
    help: "Time your hosted MCP servers spent answering tool calls, at the runner's memory size, plus a small share per request. Idle servers cost nothing.",
  },
  {
    key: "storageGb",
    label: "Workspaces and files",
    unit: "gb",
    share: "storageGb",
    color: "var(--color-usage-storage)",
    help: "What the latest daily snapshot found stored in your workspaces, chat attachments, skills and bundles. A size, not a monthly total. A project counts its own workspaces; the rest is the organization's.",
  },
  {
    key: "egressGb",
    label: "Egress",
    unit: "gb",
    share: "egressGb",
    color: "var(--color-usage-egress)",
    help: "Data served out of Broods storage, such as media your agents sent to channels. Files on your own bucket are not counted.",
  },
  {
    key: "ingressGb",
    label: "Ingress",
    unit: "gb",
    share: null,
    color: "var(--color-usage-ingress)",
  },
];

export interface AllowanceRow {
  key: keyof UsageAmounts;
  label: string;
  unit: AmountUnit;
  share: keyof BudgetUsage["shares"] | null;
  color: string;
  help?: string;
}

export function usageSlices(
  budget: BudgetUsage,
  projects: NonNullable<BudgetUsage["projects"]> = budget.projects ?? [],
): UsageSlice[] {
  const slices: UsageSlice[] = projects.map((project, index) => ({
    projectId: project.projectId,
    name: project.name,
    color: SERIES_COLORS[index % SERIES_COLORS.length],
    totals: project.totals,
    days: project.days,
  }));
  const byDay = slices.map(
    (slice) => new Map(slice.days.map((day) => [day.day, day])),
  );
  const other: UsageSlice = {
    projectId: null,
    name: "Other usage",
    color: OTHER_USAGE_COLOR,
    totals: remainder(
      budget.totals,
      slices.map((slice) => slice.totals),
    ),
    days: budget.days.map((day) => ({
      day: day.day,
      ...remainder(
        day,
        byDay.map((days) => days.get(day.day) ?? EMPTY_AMOUNTS),
      ),
    })),
  };
  const hasOther = Object.values(other.totals).some(
    (amount) => (amount ?? 0) > 0,
  );

  return hasOther ? [...slices, other] : slices;
}

export function projectSlices(
  budget: BudgetUsage,
  projectId: string,
): [UsageSlice, UsageSlice] {
  const nothing: UsageAmounts = {
    ...EMPTY_AMOUNTS,
    storageGb: budget.totals.storageGb === null ? null : 0,
  };
  const mine = budget.projects?.find(
    (project) => project.projectId === projectId,
  ) ?? {
    projectId: projectId as Id<"projects">,
    name: "This project",
    totals: nothing,
    days: [],
  };
  const [own, ...rest] = usageSlices(budget, [mine]);
  const others = rest.at(0);

  return [
    { ...own, color: "var(--color-foreground)" },
    {
      projectId: null,
      name: "Rest of the organization",
      color: OTHER_USAGE_COLOR,
      totals: others?.totals ?? nothing,
      days: others?.days ?? [],
    },
  ];
}

export function otherOrgsSlice(budget: BudgetUsage): UsageSlice | null {
  if (!budget.pool?.shared) return null;

  return {
    projectId: null,
    name: "Other organizations",
    color: OTHER_ORGS_COLOR,
    totals: remainder(budget.pool.totals, [budget.totals]),
    days: [],
  };
}

export const EMPTY_AMOUNTS: UsageAmounts = {
  sandboxHours: 0,
  hostedMcpHours: 0,
  storageGb: 0,
  egressGb: 0,
  ingressGb: 0,
};

function remainder(whole: UsageAmounts, parts: UsageAmounts[]): UsageAmounts {
  const left = (key: Exclude<keyof UsageAmounts, "storageGb">): number => {
    const rest = parts.reduce((sum, part) => sum - part[key], whole[key]);

    return rest > FLOAT_NOISE ? rest : 0;
  };
  const storage = parts.reduce<number | null>(
    (sum, part) =>
      sum === null || part.storageGb === null ? null : sum - part.storageGb,
    whole.storageGb,
  );

  return {
    sandboxHours: left("sandboxHours"),
    hostedMcpHours: left("hostedMcpHours"),
    storageGb: storage === null ? null : storage > FLOAT_NOISE ? storage : 0,
    egressGb: left("egressGb"),
    ingressGb: left("ingressGb"),
  };
}

export function billingReset(month: string): string {
  const [year, nextMonthIndex] = month.split("-").map(Number);

  return formatDay(Date.UTC(year, nextMonthIndex, 1));
}

export function dailySeries(
  month: string,
  sources: Array<{ days: UsageDay[] }>,
  key: keyof UsageAmounts,
  now: number = Date.now(),
): { bucketStarts: number[]; rows: Array<Array<number | null>> } {
  const [year, monthNumber] = month.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const byDay = sources.map(
    (source) => new Map(source.days.map((day) => [day.day, day])),
  );
  const bucketStarts = Array.from({ length: dayCount }, (_, index) =>
    Date.UTC(year, monthNumber - 1, index + 1),
  );
  const rows = bucketStarts.map((start) => {
    const date = new Date(start).toISOString().slice(0, 10);

    return byDay.map((days) => {
      const day = days.get(date);
      if (!day) return key === "storageGb" || start > now ? null : 0;

      return day[key];
    });
  });

  return { bucketStarts: bucketStarts, rows: rows };
}

// `scaleBy` picks the unit: the series max on a chart axis, so every tick shares it.
export function formatAmount(
  value: number | null,
  unit: AmountUnit,
  scaleBy: number | null = value,
): string {
  if (value === null) return "–";
  const units = DISPLAY_UNITS[unit];
  const shown =
    units.find(({ perUnit }) => (scaleBy ?? 0) * perUnit >= 1) ??
    units[scaleBy ? units.length - 1 : 0];
  const scaled = value * shown.perUnit;
  if (scaled > 0 && scaled < 0.01) return `<0.01${shown.label}`;

  return `${scaled.toLocaleString([], { maximumFractionDigits: scaled < 10 ? 2 : 1 })}${shown.label}`;
}

export function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";

  return `${Math.round(percent)}%`;
}

export function monthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);

  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString([], {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function poolNote(budget: BudgetUsage): string | null {
  const pool = budget.pool;
  if (!pool?.shared) return null;

  return pool.orgs === undefined
    ? "Limits are shared with the owner's other organizations."
    : `Limits are shared across ${pool.orgs} organizations.`;
}
