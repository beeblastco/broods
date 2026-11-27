import { afterEach, describe, expect, it } from "bun:test";
import * as nats from "../src/shared/nats.ts";

const originalEnvironment = process.env.DEPLOYMENT_ENVIRONMENT;

afterEach((): void => {
  if (originalEnvironment === undefined)
    delete process.env.DEPLOYMENT_ENVIRONMENT;
  else process.env.DEPLOYMENT_ENVIRONMENT = originalEnvironment;
});

describe("natsNames", (): void => {
  it("puts two environments' frames on different subjects", (): void => {
    const production = subjectsFor("production");
    const development = subjectsFor("development");

    expect(development.response).not.toBe(production.response);
    expect(development.logs).not.toBe(production.logs);
    expect(development.traces).not.toBe(production.traces);
  });

  it("gives two environments disjoint streams, buckets and subjects", (): void => {
    const production = nats.natsNames("production");
    const development = nats.natsNames("development");

    for (const key of [
      "observabilityStream",
      "responseStream",
      "spentTicketBucket",
      "subjectRoot",
    ] as const) {
      expect(production[key]).not.toBe(development[key]);
    }
    for (const subject of Object.values(subjectsFor("development"))) {
      expect(matchesAny(subject, [production.responseSubjectWildcard])).toBe(
        false,
      );
      expect(matchesAny(subject, production.observabilitySubjects)).toBe(false);
    }
  });

  it("binds each environment's own frames to its own streams", (): void => {
    const names = nats.natsNames("production");
    const subjects = subjectsFor("production");

    expect(matchesAny(subjects.response, [names.responseSubjectWildcard])).toBe(
      true,
    );
    expect(matchesAny(subjects.logs, names.observabilitySubjects)).toBe(true);
    expect(matchesAny(subjects.traces, names.observabilitySubjects)).toBe(true);
  });

  it("never overlaps the unprefixed streams left on the server", (): void => {
    const legacy = [
      "v1.*.*.ws.response.*",
      "v1.*.*.*.logs.>",
      "v1.*.*.*.traces.>",
    ];

    for (const subject of Object.values(subjectsFor("production"))) {
      expect(matchesAny(subject, legacy)).toBe(false);
    }
  });

  it("refuses to name anything without a plain environment token", (): void => {
    delete process.env.DEPLOYMENT_ENVIRONMENT;

    expect(() => nats.natsNames()).toThrow(/DEPLOYMENT_ENVIRONMENT/);
    expect(() => nats.natsNames("prod.v1")).toThrow(/DEPLOYMENT_ENVIRONMENT/);
    expect(() => nats.natsNames("*")).toThrow(/DEPLOYMENT_ENVIRONMENT/);
  });
});

function matchesAny(subject: string, patterns: string[]): boolean {
  return patterns.some((pattern: string): boolean => {
    const tokens = subject.split(".");
    const wanted = pattern.split(".");

    return wanted.every((token: string, index: number): boolean =>
      token === ">"
        ? tokens.length > index
        : (token === "*" || token === tokens[index]) &&
          (index < wanted.length - 1 || tokens.length === wanted.length),
    );
  });
}

function subjectsFor(environment: string): {
  logs: string;
  response: string;
  traces: string;
} {
  process.env.DEPLOYMENT_ENVIRONMENT = environment;

  return {
    logs: nats.logsSubject("acct1", "proj", "dev", "endpoint1"),
    response: nats.streamResponseSubject("acct1", "agent1", "conv-1"),
    traces: nats.tracesSubject("acct1", "proj", "dev", "endpoint1"),
  };
}
