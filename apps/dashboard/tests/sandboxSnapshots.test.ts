import { describe, expect, test } from "bun:test";
import { snapshotImage, snapshotOptions } from "../app/lib/sandboxSnapshots";

const ROWS = [
  {
    name: "crawler",
    provider: "sandbox" as const,
    status: "active" as const,
    externalImageId: "img-crawler",
  },
  {
    name: "scraper",
    provider: "lambda" as const,
    status: "active" as const,
    externalImageId: "arn:aws:lambda:us-east-1:1:microvm-image:scraper",
  },
  {
    name: "half-built",
    provider: "lambda" as const,
    status: "building" as const,
    externalImageId: "arn:aws:lambda:us-east-1:1:microvm-image:half",
  },
];

describe("snapshotOptions", () => {
  test("lists only the provider's active snapshots, pinned by image id", () => {
    expect(snapshotOptions(ROWS, "lambda", undefined)).toEqual([
      { value: "none", label: "None" },
      {
        value: "arn:aws:lambda:us-east-1:1:microvm-image:scraper",
        label: "scraper",
      },
    ]);
    expect(snapshotOptions(ROWS, "sandbox", undefined)).toEqual([
      { value: "none", label: "None" },
      { value: "img-crawler", label: "crawler" },
    ]);
  });

  test("keeps a pin from code that the list does not have", () => {
    expect(snapshotOptions(ROWS, "sandbox", "img-from-code")).toEqual([
      { value: "none", label: "None" },
      { value: "img-crawler", label: "crawler" },
      { value: "img-from-code", label: "img-from-code" },
    ]);
  });

  test("shows a listed pin once", () => {
    expect(snapshotOptions(ROWS, "sandbox", "img-crawler")).toHaveLength(2);
  });

  test("offers only None when the account has no snapshots", () => {
    expect(snapshotOptions([], "lambda", undefined)).toEqual([
      { value: "none", label: "None" },
    ]);
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
