/**
 * The sandbox log forwarder turns one CloudWatch subscription delivery into one
 * OTLP/HTTP push. These pin the two contracts it sits between: the stream name
 * core writes, and the attributes the collector and Loki index on.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  handler,
  otlpLogsRequest,
  parseLogStream,
  redact,
} from "../../lambda/sandbox-log-forwarder.mjs";

const STREAM = "acct-1/proj/dev/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
const LOG_GROUP = "/broods/dev/microvms";

type CloudWatchPayload = {
  messageType: string;
  logGroup: string;
  logStream: string;
  logEvents: Array<{ id: string; timestamp: number; message: string }>;
};

function attributes(
  list: Array<{ key: string; value: { stringValue: string } }>,
): Record<string, string> {
  return Object.fromEntries(
    list.map((item) => [item.key, item.value.stringValue]),
  );
}

function cloudWatchEvent(payload: CloudWatchPayload): {
  awslogs: { data: string };
} {
  return {
    awslogs: {
      data: gzipSync(Buffer.from(JSON.stringify(payload))).toString("base64"),
    },
  };
}

function payload(
  overrides: Partial<CloudWatchPayload> = {},
): CloudWatchPayload {
  return {
    messageType: "DATA_MESSAGE",
    logGroup: LOG_GROUP,
    logStream: STREAM,
    logEvents: [
      { id: "1", timestamp: 1_700_000_000_000, message: "server listening" },
    ],
    ...overrides,
  };
}

describe("parseLogStream", () => {
  it("splits core's stream name into tenant labels and the sandbox id", () => {
    expect(parseLogStream(STREAM)).toEqual({
      accountId: "acct-1",
      project: "proj",
      stage: "dev",
      sandboxId: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
    });
  });

  it("leaves unscoped runs unlabeled instead of indexing '-' as a tenant", () => {
    expect(parseLogStream("acct-1/-/-/uuid")).toEqual({
      accountId: "acct-1",
      project: undefined,
      stage: undefined,
      sandboxId: "uuid",
    });
  });

  it("keeps a legacy microvmId stream whole, with no tenant", () => {
    expect(parseLogStream("ai-12345678")).toEqual({
      accountId: undefined,
      project: undefined,
      stage: undefined,
      sandboxId: "ai-12345678",
    });
  });
});

describe("redact", () => {
  it("applies core's string patterns", () => {
    expect(
      redact(
        "Authorization: Bearer abc.def GET /x?token=s3cret key fp_agent_AbC-1 sts fp_sts_Z9",
      ),
    ).toBe(
      "Authorization: Bearer [redacted] GET /x?token=[redacted] key [redacted] sts [redacted]",
    );
  });
});

describe("otlpLogsRequest", () => {
  it("puts the tenant on the resource and the sandbox id on each record", () => {
    const body = otlpLogsRequest(
      payload({
        logEvents: [
          { id: "1", timestamp: 1_700_000_000_000, message: "one" },
          { id: "2", timestamp: 1_700_000_000_250, message: "Bearer tok" },
        ],
      }),
    );
    const resourceLogs = body.resourceLogs[0]!;

    expect(attributes(resourceLogs.resource.attributes)).toEqual({
      "service.name": "broods-sandbox",
      account_id: "acct-1",
      project: "proj",
      stage: "dev",
    });
    const records = resourceLogs.scopeLogs[0]!.logRecords;
    expect(records).toHaveLength(2);
    expect(records[0]!.timeUnixNano).toBe("1700000000000000000");
    expect(records[0]!.body).toEqual({ stringValue: "one" });
    expect(records[1]!.body).toEqual({ stringValue: "Bearer [redacted]" });
    expect(attributes(records[0]!.attributes)).toEqual({
      sandbox_id: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
      source: "sandbox",
      provider: "lambda",
      "aws.cloudwatch.log_group": LOG_GROUP,
      "aws.cloudwatch.log_stream": STREAM,
    });
  });
});

describe("handler", () => {
  const originalFetch = globalThis.fetch;
  const fetchMock = mock(async () => new Response(null, { status: 200 }));

  beforeEach(() => {
    process.env.OTLP_ENDPOINT = "https://otel.example.test/";
    process.env.OTLP_BASIC_AUTH = "dXNlcjpwYXNz";
    fetchMock.mockClear();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts one OTLP request per delivery with basic auth", async () => {
    await handler(cloudWatchEvent(payload()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe("https://otel.example.test/v1/logs");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Basic dXNlcjpwYXNz");
    expect(JSON.parse(init.body).resourceLogs).toHaveLength(1);
  });

  it("ignores control messages and empty batches", async () => {
    await handler(cloudWatchEvent(payload({ messageType: "CONTROL_MESSAGE" })));
    await handler(cloudWatchEvent(payload({ logEvents: [] })));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a rejected push so CloudWatch retries the delivery", async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(null, { status: 401 }),
    );

    await expect(handler(cloudWatchEvent(payload()))).rejects.toThrow(
      "OTLP push failed with HTTP 401",
    );
  });
});
