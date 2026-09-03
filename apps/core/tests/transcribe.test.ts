/**
 * Inbound audio transcription: which failure the agent is told to retry, which
 * one is handed back to it with the file, and which is the end of it.
 *
 * Driven with a stub model rather than a configured provider — `harness.test.ts`
 * replaces the provider factories process-wide, so a test that needs the real
 * ones passes or fails on file order.
 */

import { APICallError } from "@ai-sdk/provider";
import { describe, expect, it } from "bun:test";
import type { TranscriptionModel } from "ai";
import {
  transcribeAudio,
  transcribeWithModel,
} from "../src/harness/transcribe.ts";

const AUDIO = new Uint8Array([1, 2, 3]);

describe("transcribeWithModel", () => {
  it("reads the words out of a recording", async () => {
    expect(
      await transcribeWithModel(
        succeeding("whisper-1", "  check the deploy status  "),
        AUDIO,
        "openai",
        0,
      ),
    ).toEqual({ status: "transcribed", text: "check the deploy status" });
  });

  // What the agent reads has to name the formats, so the provider's own message
  // is carried through rather than replaced with our summary of it.
  it("hands a refused file back with the provider's own words", async () => {
    expect(
      await transcribeWithModel(
        failing("whisper-1", 400, "Supported formats: ['mp3', 'wav']"),
        AUDIO,
        "openai",
        0,
      ),
    ).toEqual({
      status: "failed",
      reason: "Supported formats: ['mp3', 'wav']",
      recovery: "unsupported",
    });
  });

  it("tells the agent to try again when the provider was merely busy", async () => {
    expect(
      await transcribeWithModel(
        failing("whisper-1", 429, "Rate limit reached"),
        AUDIO,
        "openai",
        0,
      ),
    ).toMatchObject({ status: "failed", recovery: "retry" });
  });

  // A rejected key is about the account, and no amount of reading the file again
  // fixes it. Spending a turn discovering that is the thing worth avoiding.
  it("treats a rejected key as nothing the agent can do", async () => {
    expect(
      await transcribeWithModel(
        failing("whisper-1", 401, "Incorrect API key"),
        AUDIO,
        "openai",
        0,
      ),
    ).toMatchObject({ status: "failed", recovery: "unavailable" });
  });
});

describe("transcribeAudio", () => {
  it("says so when the provider ships no speech-to-text", async () => {
    expect(
      await transcribeAudio(
        {
          model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
          provider: { anthropic: { apiKey: "sk-test" } },
        },
        AUDIO,
        0,
      ),
    ).toEqual({
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
): Exclude<TranscriptionModel, string> {
  return stubModel(modelId, async () => {
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
): Exclude<TranscriptionModel, string> {
  return stubModel(modelId, async () => {
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
