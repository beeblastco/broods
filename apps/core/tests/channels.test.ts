import { describe, expect, it } from "bun:test";
import type { UserContent } from "ai";
import type { ChannelImage } from "../src/shared/channels.ts";
import { ROOT_CONTEXT } from "@opentelemetry/api";
import { runWithObservabilityScope } from "../src/shared/otel.ts";
import {
  channelAttachmentBytes,
  chunkChannelText,
  extractText,
  formatChannelErrorText,
  isAllowedId,
} from "../src/shared/channels.ts";

describe("shared channel helpers", () => {
  it("extracts and concatenates only text parts from structured user content", () => {
    const content = [
      { type: "text", text: "alpha" },
      { type: "image", image: new Uint8Array([1, 2, 3]) },
      { type: "text", text: "beta" },
    ] as unknown as UserContent;

    expect(extractText(content)).toBe("alphabeta");
  });

  it("returns plain string content unchanged", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("lets every id through when there is no list or the list is the wildcard", () => {
    expect(isAllowedId(null, "C1")).toBe(true);
    expect(isAllowedId(undefined, "C1")).toBe(true);
    expect(isAllowedId(new Set(["*"]), "C1")).toBe(true);
    expect(isAllowedId(new Set(["*"]), undefined)).toBe(true);
  });

  it("admits listed ids and drops the rest", () => {
    const allowed = new Set(["C1", "C2"]);

    expect(isAllowedId(allowed, "C1")).toBe(true);
    expect(isAllowedId(allowed, "C3")).toBe(false);
  });

  it("drops an id the payload never carried, and an empty list reaches nowhere", () => {
    expect(isAllowedId(new Set(["C1"]), undefined)).toBe(false);
    expect(isAllowedId(new Set(), "C1")).toBe(false);
  });
});

describe("chunkChannelText", () => {
  it("keeps a surrogate pair whole even when it is wider than the limit", () => {
    expect(chunkChannelText("😀a", 1)).toEqual(["😀", "a"]);
  });
});

describe("channelAttachmentBytes", () => {
  it("refuses a model-chosen URL that is not public http(s)", async () => {
    const image = (url: string): ChannelImage => ({
      type: "image",
      url: url,
      name: "x.png",
    });

    expect(channelAttachmentBytes(image("file:///etc/hosts"))).rejects.toThrow(
      "only http(s) URLs are supported",
    );
    expect(
      channelAttachmentBytes(image("http://169.254.169.254/latest")),
    ).rejects.toThrow(
      "blocked private or metadata address for 169.254.169.254",
    );
  });
});

describe("formatChannelErrorText", () => {
  const TOO_LARGE =
    "Failed after 6 attempts. Last error: AI_APICallError: Request too large for gpt-6-luna in organization org-Pw28 on tokens per min (TPM): Limit 200000, Requested 204097. The input or output tokens must be reduced in order to run successfully. Visit https://platform.openai.com/account/rate-limits to learn more.";

  it("names a request over the per-minute token limit and points at /compact", () => {
    expect(formatChannelErrorText(TOO_LARGE, "telegram")).toBe(
      "⚠️ Request too large for gpt-6-luna on tokens per min (TPM): Limit 200000, Requested 204097. The input or output tokens must be reduced in order to run successfully. Send /compact to summarize the conversation, or /new to start over if that fails.",
    );
  });

  it("offers no slash command where the channel does not parse one", () => {
    expect(formatChannelErrorText(TOO_LARGE, "github")).toEndWith(
      "successfully. Start a new conversation to continue.",
    );
  });

  it("keeps the provider's wait time over a quota hint", () => {
    expect(
      formatChannelErrorText(
        "Resource has been exhausted (e.g. check quota). Please retry in 37.6s.",
      ),
    ).toBe(
      "⚠️ Resource has been exhausted (e.g. check quota). Please retry in 37.6s.",
    );
  });

  it("keeps the provider's limit numbers and wait time on a rate limit", () => {
    expect(
      formatChannelErrorText(
        "Rate limit reached for gpt-6-luna in organization org-Pw28 on tokens per min (TPM): Limit 200000, Used 141119, Requested 184355. Please try again in 37.642s. Visit https://platform.openai.com/account/rate-limits to learn more.",
      ),
    ).toBe(
      "⚠️ Rate limit reached for gpt-6-luna on tokens per min (TPM): Limit 200000, Used 141119, Requested 184355. Please try again in 37.642s.",
    );
  });

  it("keeps the provider's reason and code on a usage limit", () => {
    expect(
      formatChannelErrorText(
        "Failed after 3 attempts. Last error: Token Plan usage limit reached (2056)",
      ),
    ).toBe(
      "⚠️ Token Plan usage limit reached (2056). Add credits or upgrade the plan with the model provider.",
    );
  });

  it("leaves a provider's own 'try again later' alone", () => {
    expect(
      formatChannelErrorText("Rate limit exceeded. Please try again later."),
    ).toBe("⚠️ Rate limit exceeded. Please try again later.");
  });

  it("adds a retry hint to a dropped connection", () => {
    expect(
      formatChannelErrorText("Cannot connect to API: read ECONNRESET"),
    ).toBe("⚠️ Cannot connect to API: read ECONNRESET. Try again.");
  });

  it("redacts the tenant's secrets before the error reaches the chat", () => {
    const scope = {
      accountId: "acct",
      project: "p",
      stage: "e",
      endpointId: "ep",
      agentId: "a",
      conversationKey: "c",
      traceId: "t",
      otelContext: ROOT_CONTEXT,
      secretValues: ["tenant-secret-XYZ123"],
    };

    expect(
      runWithObservabilityScope(
        () => formatChannelErrorText("Bad token tenant-secret-XYZ123"),
        scope,
      ),
    ).toBe("⚠️ Bad token [redacted]");
  });

  it("leaves a word that only contains 'timeout' letters alone", () => {
    expect(formatChannelErrorText("Invalid runtime output schema")).toBe(
      "⚠️ Invalid runtime output schema",
    );
  });

  it("adds a retry hint to a bare rate limit", () => {
    expect(formatChannelErrorText("Rate limited (429)")).toBe(
      "⚠️ Rate limited (429). Try again in a moment.",
    );
  });
});
