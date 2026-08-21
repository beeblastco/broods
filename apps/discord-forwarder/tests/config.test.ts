import { describe, expect, it } from "bun:test";
import { parseConfigPlanes } from "../src/config.ts";

const DEV = {
  convexUrl: "https://cheerful-orca.convex.cloud",
  name: "dev",
  webhookBaseUrl: "https://gateway.dev.example.com",
};

describe("config planes", () => {
  it("reads every plane the operator listed", () => {
    const planes = parseConfigPlanes(
      JSON.stringify([
        DEV,
        {
          convexUrl: "https://kindred-avocet.convex.cloud",
          name: "prod",
          webhookBaseUrl: "https://gateway.example.com",
        },
      ]),
    );

    expect(planes.map((plane) => plane.name)).toEqual(["dev", "prod"]);
    expect(planes[1]?.webhookBaseUrl).toBe("https://gateway.example.com");
  });

  it("strips a trailing slash so the joined path has one separator", () => {
    const planes = parseConfigPlanes(
      JSON.stringify([{ ...DEV, webhookBaseUrl: "https://gateway.test/" }]),
    );

    expect(planes[0]?.webhookBaseUrl).toBe("https://gateway.test");
  });

  it("refuses a list that would leave the process with nothing to poll", () => {
    expect(() => parseConfigPlanes("[]")).toThrow(/non-empty/);
    expect(() => parseConfigPlanes("{}")).toThrow(/non-empty/);
    expect(() => parseConfigPlanes("not json")).toThrow(/valid JSON/);
    expect(() => parseConfigPlanes("[null]")).toThrow(/must be objects/);
  });

  // A name becomes part of the env var its deploy key is read from, so anything
  // that cannot appear there has to fail at startup rather than look up a key
  // the operator never wrote.
  it("refuses a name that is not usable as an env var suffix", () => {
    expect(() =>
      parseConfigPlanes(JSON.stringify([{ ...DEV, name: "" }])),
    ).toThrow(/plane names/);
    expect(() =>
      parseConfigPlanes(JSON.stringify([{ ...DEV, name: "dev stage" }])),
    ).toThrow(/plane names/);
    expect(() =>
      parseConfigPlanes(JSON.stringify([{ ...DEV, name: 7 }])),
    ).toThrow(/plane names/);
  });

  it("refuses a URL that would fail every forward instead of the startup", () => {
    expect(() =>
      parseConfigPlanes(
        JSON.stringify([{ ...DEV, webhookBaseUrl: "gateway.test" }]),
      ),
    ).toThrow(/invalid webhookBaseUrl/);
    expect(() =>
      parseConfigPlanes(JSON.stringify([{ ...DEV, convexUrl: undefined }])),
    ).toThrow(/missing convexUrl/);
  });

  // Both entries would read one deploy key and forward the same rows twice.
  it("refuses two planes under one name", () => {
    expect(() => parseConfigPlanes(JSON.stringify([DEV, DEV]))).toThrow(
      /duplicate plane names/,
    );
  });
});
