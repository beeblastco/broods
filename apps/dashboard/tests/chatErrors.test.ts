import { describe, expect, test } from "bun:test";
import {
  isStreamProtocolError,
  resolveChatError,
  runtimeStreamErrorText,
  withKnownHealthCause,
} from "../app/lib/chatErrors";

describe("resolveChatError", () => {
  test("maps the public-access JSON payload observed live", () => {
    const raw =
      '{"error":"Agent p176436nq8dvm51z7f0sa4v4qs8d637m is not publicly accessible. Enable public access and redeploy, or reach it through an internal endpoint or channel webhook.","code":"public_access_disabled","agentId":"p176436nq8dvm51z7f0sa4v4qs8d637m"}';
    const presentation = resolveChatError(raw);
    expect(presentation.title).toBe("This agent isn't reachable yet.");
    expect(presentation.action?.kind).toBe("open-details");
    expect(presentation.raw).toBe(raw);
  });

  test("maps agent-not-found from the bare JSON body", () => {
    const presentation = resolveChatError('{"error":"Agent not found"}');
    expect(presentation.title).toBe("This agent isn't deployed yet.");
    expect(presentation.action?.kind).toBe("open-details");
  });

  test("maps the runtime's missing provider key error", () => {
    // Exact string observed live over HTTP/SSE with a dangling key reference.
    const presentation = resolveChatError(
      "config.provider.vertex.apiKey is required",
    );
    expect(presentation.title).toBe(
      "The model API key for this agent is missing or wrong.",
    );
    expect(presentation.action?.kind).toBe("open-env-vars");
  });

  test("maps a provider-side invalid key rejection", () => {
    const presentation = resolveChatError(
      "API key not valid. Please pass a valid API key.",
    );
    expect(presentation.action?.kind).toBe("open-env-vars");
  });

  test("maps the runtime key auth failure", () => {
    // `unauthorizedResponse()` in core returns exactly this body on 401.
    const presentation = resolveChatError('{"error":"Unauthorized"}');
    expect(presentation.title).toBe("This stage's runtime key isn't valid.");
    expect(presentation.action?.kind).toBe("open-details");
  });

  test("maps network failures to a retry action", () => {
    for (const raw of [
      "Cannot reach core service at https://gateway.dev.broods.app. Is the service running?",
      "WebSocket connection timeout.",
      "WebSocket closed before opening.",
    ]) {
      const presentation = resolveChatError(raw);
      expect(presentation.title).toBe("Couldn't reach the agent.");
      expect(presentation.action?.kind).toBe("retry");
    }
  });

  test("unknown errors get the generic card with no action, raw preserved", () => {
    const raw = '{"whatever":"weird backend soup"}';
    const presentation = resolveChatError(raw);
    expect(presentation.title).toBe(
      "Something went wrong talking to this agent.",
    );
    expect(presentation.action).toBeUndefined();
    expect(presentation.raw).toBe(raw);
  });
});

describe("isStreamProtocolError", () => {
  test("matches the chunk-ordering message observed live", () => {
    expect(
      isStreamProtocolError(
        'Received text-end for missing text part with ID "0". Ensure a "text-start" chunk is sent before any "text-end" chunks.',
      ),
    ).toBe(true);
  });

  test("does not match real backend errors", () => {
    expect(
      isStreamProtocolError("config.provider.vertex.apiKey is required"),
    ).toBe(false);
    expect(isStreamProtocolError('{"error":"Unauthorized"}')).toBe(false);
  });
});

describe("runtimeStreamErrorText", () => {
  test("extracts the message from the runtime's error frame", () => {
    // Exact frame observed live: the runtime says `error`, the AI SDK schema
    // wants `errorText`, so these failed validation and were dropped.
    expect(
      runtimeStreamErrorText({
        type: "error",
        error: "config.provider.vertex.apiKey is required",
      }),
    ).toBe("config.provider.vertex.apiKey is required");
  });

  test("returns null for anything else", () => {
    expect(runtimeStreamErrorText({ type: "text-delta", delta: "x" })).toBe(
      null,
    );
    expect(runtimeStreamErrorText("nope")).toBe(null);
    expect(runtimeStreamErrorText(null)).toBe(null);
  });
});

describe("withKnownHealthCause", () => {
  const keyError = resolveChatError(
    "config.provider.vertex.apiKey is required",
  );

  test("quotes the failing model check on a provider-key error", () => {
    const enriched = withKnownHealthCause(keyError, [
      {
        name: "model",
        target: "vertex · gemini-2.5-pro",
        ok: false,
        message:
          "The API key points at ${NO_SUCH_KEY}, but that variable is not set on this stage.",
      },
    ]);
    expect(enriched.detail).toContain("Health check found it");
    expect(enriched.detail).toContain("vertex · gemini-2.5-pro");
    expect(enriched.action?.kind).toBe("open-env-vars");
  });

  test("passes through when no health data or no matching failure", () => {
    expect(withKnownHealthCause(keyError, null)).toBe(keyError);
    expect(withKnownHealthCause(keyError, [])).toEqual(keyError);
    expect(
      withKnownHealthCause(keyError, [
        { name: "model", target: "google", ok: true, message: "fine" },
        { name: "skill", target: "s", ok: false, message: "gone" },
      ]),
    ).toEqual(keyError);
    const network = resolveChatError("Failed to fetch");
    expect(
      withKnownHealthCause(network, [
        { name: "model", target: "google", ok: false, message: "bad key" },
      ]),
    ).toBe(network);
  });
});
