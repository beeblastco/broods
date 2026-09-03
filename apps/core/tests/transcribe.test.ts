/**
 * Inbound audio transcription: which failure gets the next model, which gets
 * handed back to the agent, and which is the end of it.
 *
 * Driven with stub models rather than a configured provider — `harness.test.ts`
 * replaces the provider factories process-wide, so a test that needs the real
 * ones passes or fails on file order.
 */

import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "bun:test";
import type { TranscriptionModel } from "ai";
import { transcribeWithModels } from "../src/harness/transcribe.ts";

const AUDIO = new Uint8Array([1, 2, 3]);

describe("transcribeWithModels", () => {
  it("falls back to the next model when one refuses the file", async () => {
    const tried: string[] = [];
    const outcome = await transcribeWithModels(
      [
        failing("gpt-4o-mini-transcribe", 400, "Invalid file format", tried),
        succeeding("whisper-1", "check the deploy status", tried),
      ],
      AUDIO,
      "openai",
      0,
    );

    expect(outcome).toEqual({
      status: "transcribed",
      text: "check the deploy status",
    });
    expect(tried).toEqual(["gpt-4o-mini-transcribe", "whisper-1"]);
  });

  // A busy provider is busy for every model it serves, so a second call is
  // waste; the agent is told to read the file again instead.
  it("stops at a provider that was merely busy", async () => {
    const tried: string[] = [];
    const outcome = await transcribeWithModels(
      [
        failing("first", 429, "Rate limit reached", tried),
        succeeding("second", "unreachable", tried),
      ],
      AUDIO,
      "openai",
      0,
    );

    expect(outcome).toMatchObject({ status: "failed", recovery: "retry" });
    expect(tried).toEqual(["first"]);
  });

  it("stops at a rejected key rather than spending the other models on it", async () => {
    const tried: string[] = [];
    const outcome = await transcribeWithModels(
      [
        failing("first", 401, "Incorrect API key", tried),
        succeeding("second", "unreachable", tried),
      ],
      AUDIO,
      "openai",
      0,
    );

    expect(outcome).toMatchObject({
      status: "failed",
      recovery: "unavailable",
    });
    expect(tried).toEqual(["first"]);
  });

  // What the agent reads has to name the formats, so the provider's own message
  // is carried through rather than replaced with our summary of it.
  it("hands back the last refusal when every model refuses", async () => {
    const outcome = await transcribeWithModels(
      [
        failing("first", 400, "Invalid file format", []),
        failing("second", 400, "Supported formats: ['mp3', 'wav']", []),
      ],
      AUDIO,
      "openai",
      0,
    );

    expect(outcome).toEqual({
      status: "failed",
      reason: "Supported formats: ['mp3', 'wav']",
      recovery: "unsupported",
    });
  });

  it("says so when the provider has no transcription model at all", async () => {
    expect(await transcribeWithModels([], AUDIO, "anthropic", 0)).toEqual({
      status: "failed",
      reason: "anthropic has no transcription model",
      recovery: "unavailable",
    });
  });
});

function failing(
  modelId: string,
  statusCode: number,
  message: string,
  tried: string[],
): Exclude<TranscriptionModel, string> {
  return stubModel(modelId, async () => {
    tried.push(modelId);
    throw new APICallError({
      message: message,
      url: "https://api.openai.com/v1/audio/transcriptions",
      requestBodyValues: {},
      statusCode: statusCode,
    });
  });
}

function succeeding(
  modelId: string,
  text: string,
  tried: string[],
): Exclude<TranscriptionModel, string> {
  return stubModel(modelId, async () => {
    tried.push(modelId);

    return {
      text: text,
      segments: [],
      language: "en",
      durationInSeconds: 1,
      warnings: [],
      response: { timestamp: new Date(0), modelId: modelId, headers: {} },
    };
  });
}

function stubModel(
  modelId: string,
  doGenerate: () => Promise<unknown>,
): Exclude<TranscriptionModel, string> {
  return {
    specificationVersion: "v4",
    provider: "stub",
    modelId: modelId,
    doGenerate: doGenerate,
  } as unknown as Exclude<TranscriptionModel, string>;
}
