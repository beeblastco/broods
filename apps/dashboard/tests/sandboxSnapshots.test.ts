import { describe, expect, test } from "bun:test";
import type { Id } from "@broods/convex/_generated/dataModel";
import { snapshotImage, snapshotOptions } from "../app/lib/sandboxSnapshots";

const DEV = "stage_dev" as Id<"stages">;
const PROD = "stage_prod" as Id<"stages">;
const PROJECT = "project_1" as Id<"projects">;

const ROWS = [
  {
    name: "crawler",
    provider: "sandbox" as const,
    status: "active" as const,
    externalImageId: "img-crawler",
    scope: { projectId: PROJECT, stageId: DEV },
    stageName: "development",
  },
  {
    name: "scraper",
    provider: "lambda" as const,
    status: "active" as const,
    externalImageId: "arn:aws:lambda:us-east-1:1:microvm-image:scraper",
    scope: { projectId: PROJECT, stageId: DEV },
    stageName: "development",
  },
  {
    name: "half-built",
    provider: "lambda" as const,
    status: "building" as const,
    externalImageId: "arn:aws:lambda:us-east-1:1:microvm-image:half",
    scope: { projectId: PROJECT, stageId: DEV },
    stageName: "development",
  },
  {
    name: "prod-disk",
    provider: "sandbox" as const,
    status: "active" as const,
    externalImageId: "img-prod",
    scope: { projectId: PROJECT, stageId: PROD },
    stageName: "production",
  },
  {
    name: "old-disk",
    provider: "sandbox" as const,
    status: "active" as const,
    externalImageId: "img-old",
  },
];

describe("snapshotOptions", () => {
  test("lists only the provider's active snapshots of this stage, with the stage", () => {
    expect(snapshotOptions(ROWS, "lambda", undefined, DEV)).toEqual([
      { value: "none", label: "None" },
      {
        value: "arn:aws:lambda:us-east-1:1:microvm-image:scraper",
        label: "scraper · development",
      },
    ]);
    expect(snapshotOptions(ROWS, "sandbox", undefined, DEV)).toEqual([
      { value: "none", label: "None" },
      { value: "img-crawler", label: "crawler · development" },
    ]);
    expect(snapshotOptions(ROWS, "sandbox", undefined, PROD)).toEqual([
      { value: "none", label: "None" },
      { value: "img-prod", label: "prod-disk · production" },
    ]);
  });

  test("keeps a pin from code that the list does not have", () => {
    expect(snapshotOptions(ROWS, "sandbox", "img-from-code", DEV)).toEqual([
      { value: "none", label: "None" },
      { value: "img-crawler", label: "crawler · development" },
      { value: "img-from-code", label: "img-from-code" },
    ]);
  });

  test("says a pinned snapshot of another stage cannot boot here", () => {
    expect(snapshotOptions(ROWS, "sandbox", "img-prod", DEV).at(-1)).toEqual({
      value: "img-prod",
      label: "prod-disk · production, cannot boot here",
    });
  });

  test("shows a listed pin once", () => {
    expect(snapshotOptions(ROWS, "sandbox", "img-crawler", DEV)).toHaveLength(
      2,
    );
  });
});

describe("snapshotImage", () => {
  const rows = [
    { baseImage: "obscura", externalImageId: "arn:snap-obscura" },
    { baseImage: "default", externalImageId: "arn:snap-default" },
  ];

  test("follows the variant a snapshot was built from", () => {
    expect(snapshotImage(rows, "arn:snap-obscura")).toBe("obscura");
  });

  test("has none for the default image or a pin the list lacks", () => {
    expect(snapshotImage(rows, "arn:snap-default")).toBeUndefined();
    expect(snapshotImage(rows, "arn:from-code")).toBeUndefined();
  });
});
