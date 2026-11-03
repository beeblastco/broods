import { expect, test } from "bun:test";
import {
  type BudgetUsage,
  dailySeries,
  OTHER_ORGS_COLOR,
  OTHER_USAGE_COLOR,
  otherOrgsSlice,
  poolNote,
  projectSlices,
  type UsageAmounts,
  usageSlices,
} from "../app/lib/allowance";
import type { Id } from "@broods/convex/_generated/dataModel";
import { PLAN_LIMITS } from "@broods/convex/model/planLimits";

const ZERO: UsageAmounts = {
  sandboxHours: 0,
  hostedMcpHours: 0,
  storageGb: 0,
  egressGb: 0,
  ingressGb: 0,
};

const NO_SHARES = {
  sandboxHours: 0,
  hostedMcpHours: 0,
  storageGb: 0,
  egressGb: 0,
};

const EXHAUSTED_POOL: Partial<BudgetUsage> = {
  usedPercent: 100,
  level: "exhausted",
  caps: PLAN_LIMITS.pro.caps,
  shares: { ...NO_SHARES, egressGb: 100, storageGb: 30 },
  pool: {
    orgs: 2,
    shared: true,
    totals: { ...ZERO, egressGb: 30, storageGb: 15 },
  },
};

function budget(
  totals: Partial<UsageAmounts>,
  days: Array<Partial<UsageAmounts> & { day: string }> = [],
  rest: Partial<BudgetUsage> = {},
): BudgetUsage {
  return {
    enforced: true,
    plan: "pro",
    month: "2026-10",
    months: ["2026-10"],
    usedPercent: 0,
    caps: null,
    shares: NO_SHARES,
    orgShares: NO_SHARES,
    level: "ok",
    totals: { ...ZERO, ...totals },
    days: days.map((day) => ({ ...ZERO, ...day })),
    ...rest,
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

test("an exhausted pool with nothing used by this org draws the bar destructive and all other organizations", () => {
  const usage = budget({ egressGb: 0, storageGb: 10 }, [], EXHAUSTED_POOL);

  const others = otherOrgsSlice(usage);

  expect(usage.level).toBe("exhausted");
  expect(others).toMatchObject({
    projectId: null,
    name: "Other organizations",
    color: OTHER_ORGS_COLOR,
    days: [],
  });
  expect(others?.totals).toEqual({ ...ZERO, egressGb: 30, storageGb: 5 });
  expect(poolNote(usage)).toBe("Limits are shared across 2 organizations.");
});

test("this org's own part of the pool is taken off the other organizations' slice, never below zero", () => {
  const full = otherOrgsSlice(budget({ egressGb: 30 }, [], EXHAUSTED_POOL));
  const ahead = otherOrgsSlice(budget({ egressGb: 31 }, [], EXHAUSTED_POOL));

  expect(full?.totals.egressGb).toBe(0);
  expect(ahead?.totals.egressGb).toBe(0);
});

test("no other organizations when the pool is this org's alone or nothing is enforced, and storage stays unknown", () => {
  expect(otherOrgsSlice(budget({}))).toBeNull();
  expect(
    otherOrgsSlice(
      budget({}, [], {
        ...EXHAUSTED_POOL,
        pool: { orgs: 1, shared: false, totals: ZERO },
      }),
    ),
  ).toBeNull();
  const unmeasured = budget({ storageGb: null }, [], EXHAUSTED_POOL);
  expect(unmeasured.pool?.totals.storageGb).toBe(15);
  expect(otherOrgsSlice(unmeasured)?.totals.storageGb).toBeNull();
});

test("the note counts the owner's organizations, says only shared to a member, and is silent for one org", () => {
  expect(poolNote(budget({}, [], EXHAUSTED_POOL))).toBe(
    "Limits are shared across 2 organizations.",
  );
  expect(
    poolNote(budget({}, [], { pool: { shared: true, totals: ZERO } })),
  ).toBe("Limits are shared with the owner's other organizations.");
  expect(
    poolNote(
      budget({}, [], { pool: { orgs: 1, shared: false, totals: ZERO } }),
    ),
  ).toBeNull();
  expect(poolNote(budget({}))).toBeNull();
});
