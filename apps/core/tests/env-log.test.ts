import { afterEach, describe, expect, it } from "bun:test";
import { booleanEnv, optionalEnv, requireEnv } from "../src/shared/env.ts";
import {
  collectSecretValues,
  logError,
  logInfo,
  logWarn,
  redact,
  redactSerialized,
  redactSensitiveText,
  redactWithRunSecrets,
} from "../src/shared/log.ts";
import { forceFlushOtel, observabilityAttributes } from "../src/shared/otel.ts";
import { sealRunToken } from "../src/shared/run-token.ts";

const BROODS_CREDENTIAL_PREFIXES = [
  "bsk_",
  "bask_",
  "bpdk_",
  "bcli_",
  "bcode_",
  "bsts_",
  "bdts_",
  "brt_",
];
const ORIGINAL_ENV = { ...process.env };
const REAL_DATE = Date;
const FIXED_TIME = "2024-01-02T03:04:05.678Z";

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.stdout.write = ORIGINAL_WRITE;
  globalThis.Date = REAL_DATE;
});

const ORIGINAL_WRITE = process.stdout.write.bind(process.stdout);

describe("environment helpers", () => {
  it("returns required environment variables when present", () => {
    process.env.REQUIRED_SAMPLE = "configured";

    expect(requireEnv("REQUIRED_SAMPLE")).toBe("configured");
  });

  it("throws when required environment variables are missing or empty", () => {
    delete process.env.MISSING_SAMPLE;
    process.env.EMPTY_SAMPLE = "";

    expect(() => requireEnv("MISSING_SAMPLE")).toThrow(
      "Missing required environment variable: MISSING_SAMPLE",
    );
    expect(() => requireEnv("EMPTY_SAMPLE")).toThrow(
      "Missing required environment variable: EMPTY_SAMPLE",
    );
  });

  it("returns undefined for optional variables when missing or empty", () => {
    delete process.env.OPTIONAL_SAMPLE;
    process.env.EMPTY_OPTIONAL_SAMPLE = "";
    process.env.SET_OPTIONAL_SAMPLE = "value";

    expect(optionalEnv("OPTIONAL_SAMPLE")).toBeUndefined();
    expect(optionalEnv("EMPTY_OPTIONAL_SAMPLE")).toBeUndefined();
    expect(optionalEnv("SET_OPTIONAL_SAMPLE")).toBe("value");
  });

  it("returns default value when boolean env var is unset", () => {
    delete process.env.BOOL_UNSET;

    expect(booleanEnv("BOOL_UNSET")).toBe(false);
    expect(booleanEnv("BOOL_UNSET", true)).toBe(true);
    expect(booleanEnv("BOOL_UNSET", false)).toBe(false);
  });

  it("returns false when boolean env var is empty", () => {
    process.env.BOOL_EMPTY = "";

    expect(booleanEnv("BOOL_EMPTY")).toBe(false);
  });

  it("parses true-like boolean values case-insensitively with trimming", () => {
    process.env.BOOL_1 = "1";
    process.env.BOOL_TRUE = "true";
    process.env.BOOL_YES = "yes";
    process.env.BOOL_ON = "on";
    process.env.BOOL_UPPER = "TRUE";
    process.env.BOOL_MIXED = "Yes";
    process.env.BOOL_SPACED = "  ON  ";

    expect(booleanEnv("BOOL_1")).toBe(true);
    expect(booleanEnv("BOOL_TRUE")).toBe(true);
    expect(booleanEnv("BOOL_YES")).toBe(true);
    expect(booleanEnv("BOOL_ON")).toBe(true);
    expect(booleanEnv("BOOL_UPPER")).toBe(true);
    expect(booleanEnv("BOOL_MIXED")).toBe(true);
    expect(booleanEnv("BOOL_SPACED")).toBe(true);
  });

  it("parses false-like boolean values case-insensitively with trimming", () => {
    process.env.BOOL_0 = "0";
    process.env.BOOL_FALSE = "false";
    process.env.BOOL_NO = "no";
    process.env.BOOL_OFF = "off";
    process.env.BOOL_UPPER_FALSE = "FALSE";
    process.env.BOOL_MIXED_NO = "No";
    process.env.BOOL_SPACED_OFF = "  off  ";

    expect(booleanEnv("BOOL_0")).toBe(false);
    expect(booleanEnv("BOOL_FALSE")).toBe(false);
    expect(booleanEnv("BOOL_NO")).toBe(false);
    expect(booleanEnv("BOOL_OFF")).toBe(false);
    expect(booleanEnv("BOOL_UPPER_FALSE")).toBe(false);
    expect(booleanEnv("BOOL_MIXED_NO")).toBe(false);
    expect(booleanEnv("BOOL_SPACED_OFF")).toBe(false);
  });

  it("throws on invalid boolean-like values", () => {
    process.env.BOOL_INVALID = "maybe";
    process.env.BOOL_INVALID_NUM = "2";
    process.env.BOOL_INVALID_YEP = "yep";

    expect(() => booleanEnv("BOOL_INVALID")).toThrow(
      "BOOL_INVALID must be a boolean-like value",
    );
    expect(() => booleanEnv("BOOL_INVALID_NUM")).toThrow(
      "BOOL_INVALID_NUM must be a boolean-like value",
    );
    expect(() => booleanEnv("BOOL_INVALID_YEP")).toThrow(
      "BOOL_INVALID_YEP must be a boolean-like value",
    );
  });
});

describe("logging helpers", () => {
  it("emits structured JSON log lines with fixed timestamps", () => {
    const lines: string[] = [];

    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );

      return true;
    }) as typeof process.stdout.write;

    globalThis.Date = class extends REAL_DATE {
      constructor(value?: string | number | Date) {
        super(value ?? FIXED_TIME);
      }

      override toISOString(): string {
        return FIXED_TIME;
      }

      static override now(): number {
        return new REAL_DATE(FIXED_TIME).valueOf();
      }
    } as DateConstructor;

    logInfo("started", { requestId: "req-1" });
    logWarn("retrying");
    logError("failed", { code: 500 });

    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        time: FIXED_TIME,
        level: "INFO",
        message: "started",
        requestId: "req-1",
        service: "broods-core",
        "service.name": "broods-core",
      },
      {
        time: FIXED_TIME,
        level: "WARN",
        message: "retrying",
        service: "broods-core",
        "service.name": "broods-core",
      },
      {
        time: FIXED_TIME,
        level: "ERROR",
        message: "failed",
        code: 500,
        service: "broods-core",
        "service.name": "broods-core",
      },
    ]);
  });

  it("redacts secret values from arbitrary strings, nested data, and auth URLs", () => {
    process.env.ACCOUNT_GOOGLE_API_KEY = "env-secret-value";
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Basic dXNlcjpwYXNz";
    const taskSecrets = collectSecretValues({
      provider: { google: { apiKey: "provider-secret-value" } },
      runtimeVariables: [{ key: "PUBLIC_URL", value: "runtime-secret-value" }],
    });

    const result = redact(
      {
        detail: "env-secret-value provider-secret-value runtime-secret-value",
        nested: { url: "https://example.test/run?token=url-secret" },
        authorization: "Bearer direct-secret",
      },
      ["env-secret-value", ...taskSecrets],
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("env-secret-value");
    expect(serialized).not.toContain("provider-secret-value");
    expect(serialized).not.toContain("runtime-secret-value");
    expect(serialized).not.toContain("url-secret");
    expect(serialized).not.toContain("direct-secret");
    expect(redactSensitiveText("request failed: Basic dXNlcjpwYXNz")).toBe(
      "request failed: Basic [redacted]",
    );
    process.env.STAGE_TICKET_SECRET = "run-token-test-secret";
    const runToken = sealRunToken({ accountId: "acct_1", agentId: "agent_1" });
    expect(redactSensitiveText(`BROODS_RUN_TOKEN=${runToken} next`)).toBe(
      "BROODS_RUN_TOKEN=[redacted] next",
    );
    expect(redactSensitiveText(`curl sent ${runToken} twice`)).toBe(
      "curl sent [redacted] twice",
    );
  });

  it("scrubs run secret values from tool data and leaves its keys alone", () => {
    process.env.ACCOUNT_GOOGLE_API_KEY = "env-secret-value";

    // Read back by the model, so a key named like a secret keeps its value.
    expect(
      redactWithRunSecrets({
        nextPageToken: "page-2",
        credentials: { user: "ada" },
        stdout: ["key env-secret-value"],
      }),
    ).toEqual({
      nextPageToken: "page-2",
      credentials: { user: "ada" },
      stdout: ["key [redacted]"],
    });
    expect(
      redactWithRunSecrets("a run-secret-value", ["run-secret-value"]),
    ).toBe("a [redacted]");
    // The log patterns stay out: prose and a paging url are not credentials.
    const prose = "a basic setup, see https://api.test/items?page=2&token=next";
    expect(redactWithRunSecrets(prose)).toBe(prose);
    expect(redactWithRunSecrets(`key bsk_${"a".repeat(43)}`)).toBe(
      "key [redacted]",
    );
    // A frame's timestamp stays what JSON.stringify would have written.
    expect(
      redactWithRunSecrets({ timestamp: new Date("2026-01-02T03:04:05Z") }),
    ).toEqual({ timestamp: "2026-01-02T03:04:05.000Z" });
  });

  it("redacts every Broods credential prefix and leaves short identifiers", () => {
    // The minted shape: the prefix plus 43 base64url chars; signed tickets add a dot.
    const body = `${"aB3-_xYz".repeat(5)}abc`;
    for (const prefix of BROODS_CREDENTIAL_PREFIXES) {
      expect(redactSensitiveText(`run failed for ${prefix}${body} twice`)).toBe(
        "run failed for [redacted] twice",
      );
    }
    expect(redactSensitiveText(`ticket bdts_${body}.${body} sent`)).toBe(
      "ticket [redacted] sent",
    );
    expect(redactSensitiveText("column bsk_id is null")).toBe(
      "column bsk_id is null",
    );
    expect(redactSensitiveText("role brole_abcdefghijklmnopqrstuvwxyz")).toBe(
      "role brole_abcdefghijklmnopqrstuvwxyz",
    );
    expect(redactSensitiveText("job bsk_abcdefghijklmnopqrs done")).toBe(
      "job bsk_abcdefghijklmnopqrs done",
    );
  });

  it("never leaks a secret that straddles a truncated attribute's cut", () => {
    const secret = "s3cr3t-value-long";
    // One straddles the cut itself; the other straddles the scrubbed window's
    // end and is pulled under the cut once the secret before it shrinks.
    const atCut = `${"x".repeat(45)}${secret}${"y".repeat(100)}`;
    const atWindow = `${secret}${"z".repeat(34)}${secret}${"y".repeat(100)}`;
    // A token the patterns match, longer than any literal secret.
    const atToken = `${"x".repeat(40)} bsk_${"a".repeat(43)} ${"y".repeat(100)}`;

    for (const text of [atCut, atWindow, atToken]) {
      const attribute = redactSerialized(text, [secret], 50);
      const whole = redact(text, [secret]) as string;

      expect(attribute).not.toContain(secret.slice(0, 4));
      expect(attribute).toBe(`${whole.slice(0, 50)}...[truncated]`);
    }
    expect(
      redactSerialized({ note: 'pa"ss-word', apiKey: "k" }, ['pa"ss-word'], 50),
    ).toBe('{"note":"[redacted]","apiKey":"[redacted]"}');
  });

  it("builds the exact tenant attributes consumed by observability queries", () => {
    expect(
      observabilityAttributes({
        accountId: "acct_1",
        project: "project-one",
        stage: "development",
        endpointId: "env-1234",
        agentId: "agent-1",
        conversationKey: "conversation-1",
      }),
    ).toEqual({
      account_id: "acct_1",
      project: "project-one",
      stage: "development",
      endpoint_id: "env-1234",
      agent_id: "agent-1",
      conversation_key: "conversation-1",
    });
  });

  it("allows an explicit OTel flush when exporters are not configured", async () => {
    await expect(forceFlushOtel()).resolves.toBeUndefined();
  });
});
