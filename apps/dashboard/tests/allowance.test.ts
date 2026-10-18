import { expect, test } from "bun:test";
import {
  type BudgetUsage,
  dailySeries,
  OTHER_USAGE_COLOR,
  projectSlices,
  type UsageAmounts,
  usageSlices,
} from "../app/lib/allowance";
import type { Id } from "@broods/convex/_generated/dataModel";

const ZERO: UsageAmounts = {
  sandboxHours: 0,
  hostedMcpHours: 0,
  storageGb: 0,
  egressGb: 0,
  ingressGb: 0,
};

function budget(
  totals: Partial<UsageAmounts>,
  days: Array<Partial<UsageAmounts> & { day: string }> = [],
): BudgetUsage {
  return {
    enforced: true,
    plan: "pro",
    month: "2026-10",
    months: ["2026-10"],
    usedPercent: 0,
    caps: null,
    shares: { sandboxHours: 0, hostedMcpHours: 0, storageGb: 0, egressGb: 0 },
    orgShares: {
      sandboxHours: 0,
      hostedMcpHours: 0,
      storageGb: 0,
      egressGb: 0,
    },
    level: "ok",
    totals: { ...ZERO, ...totals },
    days: days.map((day) => ({ ...ZERO, ...day })),
  };
}

function project(
  id: string,
  totals: Partial<UsageAmounts>,
  days: Array<Partial<UsageAmounts> & { day: string }> = [],
): NonNullable<BudgetUsage["projects"]>[number] {
  return {
    projectId: id as Id<"projects">,
    name: id,
    totals: { ...ZERO, ...totals },
    days: days.map((day) => ({ ...ZERO, ...day })),
  };
}

test("what no project used becomes Other usage, per month and per day", () => {
  const slices = usageSlices(
    budget({ egressGb: 10, storageGb: 6 }, [
      { day: "2026-10-01", egressGb: 4 },
      { day: "2026-10-02", egressGb: 6 },
    ]),
    [
      project("a", { egressGb: 3, storageGb: 2 }, [
        { day: "2026-10-01", egressGb: 3 },
      ]),
      project("b", { egressGb: 5, storageGb: 1 }, [
        { day: "2026-10-02", egressGb: 5 },
      ]),
    ],
  );

  expect(slices.map((slice) => slice.name)).toEqual(["a", "b", "Other usage"]);
  const other = slices[2];
  expect(other.projectId).toBeNull();
  expect(other.color).toBe(OTHER_USAGE_COLOR);
  expect(other.totals.egressGb).toBe(2);
  expect(other.totals.storageGb).toBe(3);
  expect(other.days.map((day) => [day.day, day.egressGb])).toEqual([
    ["2026-10-01", 1],
    ["2026-10-02", 1],
  ]);
});

test("leaves Other usage out when the projects add up to the whole", () => {
  const slices = usageSlices(budget({ egressGb: 0.3 }), [
    project("a", { egressGb: 0.1 }),
    project("b", { egressGb: 0.2 }),
  ]);

  // 0.3 - 0.1 - 0.2 is float noise, not usage.
  expect(slices.map((slice) => slice.name)).toEqual(["a", "b"]);
});

test("never goes below zero when a project's read is ahead of the org's", () => {
  const [, other] = usageSlices(budget({ egressGb: 1, ingressGb: 2 }), [
    project("a", { egressGb: 1.5 }),
  ]);

  expect(other.totals.egressGb).toBe(0);
  expect(other.totals.ingressGb).toBe(2);
});

test("keeps storage unknown when the org or a project has no snapshot", () => {
  const [, other] = usageSlices(budget({ storageGb: null, egressGb: 1 }), [
    project("a", { storageGb: null }),
  ]);
  expect(other.totals.storageGb).toBeNull();

  const [, rest] = usageSlices(budget({ storageGb: 5, egressGb: 1 }), [
    project("a", { storageGb: null }),
  ]);
  expect(rest.totals.storageGb).toBeNull();
});

test("colors projects in their own order and wraps past the palette", () => {
  const slices = usageSlices(
    budget({}),
    Array.from({ length: 7 }, (_, index) => project(`p${index}`, {})),
  );

  expect(slices).toHaveLength(7);
  expect(slices[0].color).toBe(slices[6].color);
  expect(new Set(slices.slice(0, 6).map((slice) => slice.color)).size).toBe(6);
});

test("charts one value per source and day, gaps for days to come", () => {
  const now = Date.UTC(2026, 9, 2, 12);
  const series = dailySeries(
    "2026-10",
    [
      { days: [{ ...ZERO, day: "2026-10-01", egressGb: 2 }] },
      { days: [{ ...ZERO, day: "2026-10-02", egressGb: 3 }] },
    ],
    "egressGb",
    now,
  );

  expect(series.bucketStarts).toHaveLength(31);
  expect(series.rows.slice(0, 3)).toEqual([
    [2, 0],
    [0, 3],
    [null, null],
  ]);
});

test("charts a storage day with no snapshot as unknown, not zero", () => {
  const series = dailySeries(
    "2026-10",
    [{ days: [{ ...ZERO, day: "2026-10-02", storageGb: 4 }] }],
    "storageGb",
    Date.UTC(2026, 9, 3),
  );

  expect(series.rows.slice(0, 2)).toEqual([[null], [4]]);
});

test("one project's view folds every other project into one grey part", () => {
  const usage = {
    ...budget({ egressGb: 10 }),
    projects: [project("a", { egressGb: 3 }), project("b", { egressGb: 5 })],
  };

  const [own, others] = projectSlices(usage, "a");

  expect(own).toMatchObject({ projectId: "a", name: "a" });
  expect(own.totals.egressGb).toBe(3);
  expect(others.projectId).toBeNull();
  expect(others.name).toBe("Rest of the organization");
  expect(others.color).toBe(OTHER_USAGE_COLOR);
  expect(others.totals.egressGb).toBe(7);
});

test("a project alone in its org has an empty other part with its own key", () => {
  const usage = {
    ...budget({ egressGb: 3 }),
    projects: [project("a", { egressGb: 3 })],
  };

  const [own, others] = projectSlices(usage, "a");

  expect(own.projectId).toBe("a");
  expect(others.projectId).toBeNull();
  expect(others.totals).toEqual(ZERO);
});

test("a project missing from the org's list shows nothing used, not the org's rest", () => {
  const usage = {
    ...budget({ egressGb: 4 }),
    projects: [project("b", { egressGb: 1 })],
  };

  const [own, others] = projectSlices(usage, "new");

  expect(own.projectId).toBe("new");
  expect(own.totals).toEqual(ZERO);
  expect(others.totals.egressGb).toBe(4);
});

test("before the month's first snapshot both parts keep storage unknown", () => {
  const usage = {
    ...budget({ storageGb: null, egressGb: 1 }),
    projects: [project("a", { storageGb: null, egressGb: 1 })],
  };

  const [own, others] = projectSlices(usage, "a");
  const [missing] = projectSlices(usage, "new");

  expect(own.totals.storageGb).toBeNull();
  expect(others.totals.storageGb).toBeNull();
  expect(missing.totals.storageGb).toBeNull();
});
